// scripts/check-renewals.js
// สคริปต์เช็ควันครบกำหนด + ส่งอีเมลแจ้งเตือน — รันโดย GitHub Actions ทุกเช้า
// (ไม่ต้องพึ่งเซิร์ฟเวอร์ Render ที่หลับ: อ่านข้อมูลจาก Turso แล้วส่งผ่าน Resend โดยตรง)

const { createClient } = require('@tursodatabase/serverless/compat');

const LEAD_DAYS = 7; // แจ้งเมื่อเหลือ 7 วันหรือน้อยกว่า (และแจ้งต่อถ้าเลยกำหนดแล้ว)
const SEND_TIME = '08:15'; // เวลาที่ต้องการให้เมลถึง (เวลาไทย) — ให้ Resend เป็นคนปล่อยเมลตามเวลานี้
const SAFETY_MS = 60 * 1000; // ถ้าเหลือเวลาน้อยกว่า 1 นาทีก่อนถึงเวลา ให้ส่งทันที

// วันที่ปัจจุบันตามเวลาไทย รูปแบบ YYYY-MM-DD
function bangkokToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

// จำนวนวันจาก today ถึง dueDate (ติดลบ = เลยกำหนดแล้ว) คิดเป็นวันเต็มแบบ UTC กันปัญหา timezone
function daysUntil(dueDate, today) {
  return Math.round((Date.parse(dueDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}

// แยกรายการที่ต้องแจ้ง: ข้ามที่ต่ออายุแล้ว / ไม่มีวันครบกำหนด / ถูกแจ้งไปแล้ววันนี้
function classify(items, today) {
  const overdue = [];
  const dueSoon = [];
  for (const item of items) {
    if (item.renewed || !item.dueDate) continue;
    if (item.lastNotifiedDate === today) continue;
    const daysLeft = daysUntil(item.dueDate, today);
    if (daysLeft < 0) overdue.push({ ...item, daysLeft });
    else if (daysLeft <= LEAD_DAYS) dueSoon.push({ ...item, daysLeft });
  }
  return { overdue, dueSoon };
}

// คืนเวลา (ISO) ที่จะให้ Resend ปล่อยเมล หรือ null ถ้าเลยเวลาแล้ว (ให้ส่งทันที)
// ตัวสคริปต์จึงรันเมื่อไหร่ก่อน 08:15 ก็ได้ ความตรงเวลาของเมลไม่ขึ้นกับความช้าของ GitHub
function computeScheduledAt(now, today) {
  const target = new Date(`${today}T${SEND_TIME}:00+07:00`);
  if (target.getTime() - now.getTime() > SAFETY_MS) return target.toISOString();
  return null;
}

function buildEmailText(overdue, dueSoon) {
  const lines = [];
  if (overdue.length) {
    lines.push('=== เลยกำหนดแล้ว ===');
    overdue.forEach(it => lines.push(`- ${it.name}: เลยกำหนดมา ${Math.abs(it.daysLeft)} วัน (ครบกำหนด ${it.dueDate})`));
  }
  if (dueSoon.length) {
    if (lines.length) lines.push('');
    lines.push('=== ใกล้ครบกำหนด ===');
    dueSoon.forEach(it => lines.push(`- ${it.name}: เหลืออีก ${it.daysLeft} วัน (ครบกำหนด ${it.dueDate})`));
  }
  return lines.join('\n');
}

// แปลงผลลัพธ์จาก Turso ให้เป็น object ที่มีชื่อคอลัมน์ (เหมือนใน server.js)
function rowsToObjects(result) {
  const columns = result.columns || [];
  return result.rows.map(row => {
    if (Array.isArray(row)) {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    }
    if (columns.length === 0) return row;
    const obj = {};
    columns.forEach(col => { obj[col] = row[col]; });
    return obj;
  });
}

async function sendEmail(text, scheduledAt) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: process.env.NOTIFY_EMAIL,
      subject: 'แจ้งเตือน: รายการที่ต้องต่ออายุ',
      text,
      ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Resend API error (${response.status}): ${await response.text()}`);
  }
}

async function main() {
  const required = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'RESEND_API_KEY', 'NOTIFY_EMAIL'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) {
    throw new Error(`ยังไม่ได้ตั้งค่า secrets: ${missing.join(', ')}`);
  }

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const today = bangkokToday();
  const result = await db.execute('SELECT * FROM items');
  const items = rowsToObjects(result);
  const { overdue, dueSoon } = classify(items, today);
  const flagged = [...overdue, ...dueSoon];

  console.log(`วันที่ (เวลาไทย): ${today} | รายการทั้งหมด: ${items.length} | ต้องแจ้ง: ${flagged.length}`);

  if (flagged.length === 0) {
    console.log('ไม่มีรายการที่ต้องแจ้งเตือนวันนี้');
    return;
  }

  const scheduledAt = computeScheduledAt(new Date(), today);
  await sendEmail(buildEmailText(overdue, dueSoon), scheduledAt);
  // บันทึกว่าแจ้งแล้ววันนี้ (กันส่งซ้ำถ้ารันรอบสำรอง) — ทำหลัง Resend รับคำสั่งสำเร็จเท่านั้น
  for (const item of flagged) {
    await db.execute('UPDATE items SET lastNotifiedDate = ? WHERE id = ?', [today, item.id]);
  }
  if (scheduledAt) {
    console.log(`ตั้งเวลาส่งอีเมล ${flagged.length} รายการกับ Resend แล้ว จะถึงตอน ${SEND_TIME} น. (${scheduledAt})`);
  } else {
    console.log(`เลยเวลา ${SEND_TIME} น. แล้ว ส่งอีเมล ${flagged.length} รายการทันที`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('ผิดพลาด:', err.message);
    process.exit(1); // ให้ GitHub ถือว่า run ล้มเหลว และแจ้งเตือนทางอีเมล
  });
}

module.exports = { classify, daysUntil, bangkokToday, buildEmailText, rowsToObjects, computeScheduledAt };
