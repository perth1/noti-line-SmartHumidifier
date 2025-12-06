const admin = require("firebase-admin");
const axios = require("axios");
const fs = require("fs");

// 1) อ่าน service account key
const serviceAccount = require("./serviceAccountKey.json");

// 2) ใส่ค่า databaseURL ให้ตรงกับของโปรเจกต์คุณ
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://embedded-curtain-project-default-rtdb.asia-southeast1.firebasedatabase.app/" // แก้ให้ตรงของคุณ(แก้แล้ว)
});

const db = admin.database();

// 3) ใส่ LINE Channel access token ของ OA
const LINE_CHANNEL_TOKEN = "uwvu5pHFwTNzRSju0sgm3WGqFUg4xm6R/cNavlKtMxZxm/ESPqThtiymdbdvjBgjirkrDdSbuowG6AfmTbqNknMAWTK4UUivr48qday32LOTlIK//vq1HhUai1C2jvMVP/StEniCDbGgvWXJFsOaAwdB04t89/1O/w1cDnyilFU=";
const LINE_BROADCAST_URL = "https://api.line.me/v2/bot/message/broadcast";

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

// --------------------
// ฟังก์ชันช่วยจำค่าเก่า เพื่อรู้ว่า "เปลี่ยน" จริงไหม
// --------------------



let prevSteamSchedule = null;

function timestampToTimeHM(ts) {
  if (!ts) return "-";
  const date = new Date(Number(ts) * 1000);
  return date.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Bangkok",
  });
}

//notiเวลาที่เปิดเครื่องและปิดเครื่อง
function watchSteamSchedule() {
  const ref = db.ref("steam/control");

  ref.on("value", (snapshot) => {
    const after = snapshot.val();
    if (!after) return;

    // ถ้ายังไม่เคยมีค่าเก่า → เก็บไว้ก่อน ยังไม่แจ้งเตือน
    if (!prevSteamSchedule) {
      prevSteamSchedule = {
        sched_start: after.sched_start,
        sched_end: after.sched_end
      };
      return;
    }

    const before = prevSteamSchedule;

    // เก็บข้อความที่ต้องแจ้ง
    let msg = "";

    // 🔥 1) เช็คเฉพาะ sched_start แทน
    if (before.sched_start !== after.sched_start) {
      const startTime = timestampToTimeHM(after.sched_start);
      msg = `เครื่องเริ่มพ่นไอน้ำ เวลา: ${startTime} น.`;
    }

    // 🔥 2) เช็คเฉพาะ sched_end แทน
    else if (before.sched_end !== after.sched_end) {
      const endTime = timestampToTimeHM(after.sched_end);
      msg = `เครื่องหยุดพ่นไอน้ำ เวลา: ${endTime} น.`;
    }

    // ส่งแจ้งเตือนถ้ามีการเปลี่ยนจริง
    if (msg) {
      sendLineAlert(msg);
      console.log("Send schedule update:", msg);
    }

    // อัปเดตค่าเก่า
    prevSteamSchedule = {
      sched_start: after.sched_start,
      sched_end: after.sched_end
    };
  });
}




// --------------------
// main
// --------------------
console.log("Firebase LINE bridge started...");
watchSteamSchedule();

