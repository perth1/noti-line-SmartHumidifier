require('dotenv').config();

const admin = require("firebase-admin");
const axios = require("axios");
const fs = require("fs");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL
});

const db = admin.database();

const LINE_CHANNEL_TOKEN = process.env.LINE_CHANEL_TOKEN;
const LINE_BROADCAST_URL = process.env.LINE_BROADCAST_URL;

// ฟังก์ชันยิงแจ้งเตือนไป LINE (broadcast ให้ทุกคนที่แอด OA)
async function sendLineAlert(message) {
  try {
    const res = await axios.post(
      LINE_BROADCAST_URL,
      {
        messages: [
          {
            type: "text",
            text: message,
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LINE_CHANNEL_TOKEN}`,
        },
      }
    );
    console.log("LINE broadcast ok:", res.data);
  } catch (err) {
    console.error(
      "Error sending LINE:",
      err.response?.data || err.message
    );
  }
}

// เก็บสถานะการแจ้งเตือนของวันนี้
let scheduleNotifyState = {
  date: null,   // string เช่น "2025-12-07"
  start15: false,
  start5: false,
  stop15: false,
  stop5: false,
};

async function isMachineOn() {
  const snap = await db.ref("control/control_state").once("value");
  const val = snap.val();
  return !!val; // true = เปิด, false/undefined/null = ปิด
}

function resetScheduleFlagsIfNewDay() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

  if (scheduleNotifyState.date !== todayStr) {
    scheduleNotifyState = {
      date: todayStr,
      start15: false,
      start5: false,
      stop15: false,
      stop5: false,
    };
    console.log("Reset schedule flags for new day:", todayStr);
  }
}

function getTodayTimeFromHHMM(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (isNaN(h) || isNaN(m)) return null;

  const now = new Date();
  // ใช้เวลาเครื่อง (ถ้า set timezone เป็นไทยแล้วจะตรง Asia/Bangkok)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
}

async function checkScheduleReminderOnce() {
  resetScheduleFlagsIfNewDay();

  const snap = await db.ref("schedule").once("value");
  const data = snap.val();
  if (!data) return;

  if (!data.enable) {
    // ไม่เปิดใช้ schedule ไม่ต้องแจ้งอะไร
    return;
  }

  const startTime = getTodayTimeFromHHMM(data.start_time);
  const stopTime  = getTodayTimeFromHHMM(data.stop_time);

  if (!startTime || !stopTime) {
    console.log("Invalid start_time/stop_time:", data.start_time, data.stop_time);
    return;
  }

  const now = new Date();
  const diffStartMin = (startTime - now) / 60000; // เหลืออีกกี่นาทีก่อนเริ่ม
  const diffStopMin  = (stopTime  - now) / 60000; // เหลืออีกกี่นาทีก่อนหยุด

  function isAround(targetMin, diff) {
    // ถ้าตั้งให้เช็คทุก ~30-60 วิ แบบนี้จะเข้าเคสสักรอบหนึ่ง
    return diff <= targetMin && diff > targetMin - 1;
  }

  // ---------- ก่อน "เริ่มทำงาน" ----------
  if (isAround(15, diffStartMin) && !scheduleNotifyState.start15) {
    const msg = "⏰ เครื่องจะเริ่มทำงานในอีก 15 นาที";
    await sendLineAlert(msg);
    console.log("Schedule reminder:", msg);
    scheduleNotifyState.start15 = true;
  }

  if (isAround(5, diffStartMin) && !scheduleNotifyState.start5) {
    const msg = "⏰ เครื่องจะเริ่มทำงานในอีก 5 นาที";
    await sendLineAlert(msg);
    console.log("Schedule reminder:", msg);
    scheduleNotifyState.start5 = true;
  }

  // ---------- ก่อน "หยุดทำงาน" ----------
  // เพิ่ม logic เช็คว่าเครื่องเปิดอยู่จริง ๆ ก่อนค่อย noti
  const machineOn = await isMachineOn();  // << จุดสำคัญ

  if (machineOn) {
    // เครื่องเปิดอยู่ → ค่อยมีความหมายว่าจะ "หยุดทำงานในอีก X นาที"
    if (isAround(15, diffStopMin) && !scheduleNotifyState.stop15) {
      const msg = "⏰ เครื่องจะหยุดทำงานในอีก 15 นาที";
      await sendLineAlert(msg);
      console.log("Schedule reminder:", msg);
      scheduleNotifyState.stop15 = true;
    }

    if (isAround(5, diffStopMin) && !scheduleNotifyState.stop5) {
      const msg = "⏰ เครื่องจะหยุดทำงานในอีก 5 นาที";
      await sendLineAlert(msg);
      console.log("Schedule reminder:", msg);
      scheduleNotifyState.stop5 = true;
    }
  } else {
    // เครื่องยังไม่เปิด → ไม่ต้อง noti ฝั่งหยุดงาน
    // (จะเงียบไว้เลย)
    // console.log("Machine is OFF → skip stop reminders");
  }
}


function startScheduleReminderLoop() {
  // เช็คทันที 1 ครั้ง
  checkScheduleReminderOnce().catch(console.error);

  // แล้วเช็คซ้ำทุก ๆ 30 วินาที
  setInterval(() => {
    checkScheduleReminderOnce().catch(console.error);
  }, 30 * 1000);
}


// --------------------
// ฟังก์ชันช่วยจำค่าเก่า เพื่อรู้ว่า "เปลี่ยน" จริงไหม
// --------------------



let prevSteamState = null;

function watchSteamState() {
  const ref = db.ref("control");

  ref.on("value", (snapshot) => {
    const after = snapshot.val();
    if (!after) return;

    const current = after.control_state;

    // ถ้ายังไม่เคยมีค่าเก่า → เก็บไว้ก่อน ยังไม่แจ้งเตือน
    if (prevSteamState === null) {
      prevSteamState = current;
      return;
    }

    let msg = "";

    // เช็คว่ามีการเปลี่ยนสถานะจริงไหม
    if (prevSteamState !== current) {
      if (current) {
        msg = "เครื่องทำความชื้นเริ่มพ่นไอน้ำแล้ว";
      } else {
        msg = "เครื่องทำความชื้นหยุดพ่นไอน้ำแล้ว";
      }
    }

    // ถ้ามีข้อความ → ส่ง LINE
    if (msg !== "") {
      sendLineAlert(msg);
      console.log("Send steam_state update:", msg);
    }

    // อัปเดตค่าเก่า
    prevSteamState = current;
  });
}


let prevTiltState = null;

function watchTiltSensor() {
  const ref = db.ref("sensor/tilt");

  ref.on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    const current = data.state;

    // ถ้ายังไม่มีค่าเก่า → เก็บไว้ก่อน ยังไม่แจ้งเตือน
    if (prevTiltState === null) {
      prevTiltState = current;
      return;
    }

    // ตรวจเฉพาะตอน state = 1 หรือ 2
    if (current === 1 || current === 2) {
      if (prevTiltState !== current) {
        sendLineAlert("⚠️ ตัวเครื่องเอียงระวังถังน้ำตก");
        console.log("Tilt warning sent. State =", current);
      }
    }

    prevTiltState = current;
  });
}

let lowWaterNotified = false;
function watchWaterLevel() {
  const ref = db.ref("sensor/water");

  ref.on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    const percent = Number(data.percent);
    if (isNaN(percent)) {
      console.log("water percent is not a number:", data.percent);
      return;
    }

    console.log("water level:", percent, "%");

    // ถ้าต่ำกว่า 20% → แจ้งเตือน (ครั้งแรกเท่านั้น)
    if (percent < 20) {
      if (!lowWaterNotified) {
        const msg = `💧 ระดับน้ำเหลือต่ำกว่า 20%\n   กรุณาเติมน้ำในถัง`;
        sendLineAlert(msg);
        console.log("Send low water alert:", msg);
        lowWaterNotified = true;
      }
    } else {
      // ถ้ากลับมามากกว่าหรือเท่ากับ 20% → reset flag
      if (lowWaterNotified) {
        console.log("Water level back to normal:", percent);
      }
      lowWaterNotified = false;
    }
  });
}



// -----------------------------------------------
console.log("Firebase LINE bridge started...");
watchSteamState();
watchTiltSensor();
watchWaterLevel();
startScheduleReminderLoop();