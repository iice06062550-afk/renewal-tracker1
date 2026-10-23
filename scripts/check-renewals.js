// scripts/check-renewals.js
// สคริปต์เช็ควันครบกำหนด + ส่งอีเมลแจ้งเตือน — รันโดย GitHub Actions ทุกเช้า
// (ไม่ต้องพึ่งเซิร์ฟเวอร์ Render ที่หลับ: อ่านข้อมูลจาก Turso แล้วส่งผ่าน Resend โดยตรง)

const { createClient } = require('@tursodatabase/serverless/compat');

const LEAD_DAYS = 7; // แจ้งเมื่อเหลือ 7 วันหรือน้อยกว่า (และแจ้งต่อถ้าเลยกำหนดแล้ว)

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

async function sendEmail(text) {
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

  await sendEmail(buildEmailText(overdue, dueSoon));
  // บันทึกว่าแจ้งแล้ววันนี้ (กันส่งซ้ำถ้ารันรอบสำรอง) — ทำหลังส่งสำเร็จเท่านั้น
  for (const item of flagged) {
    await db.execute('UPDATE items SET lastNotifiedDate = ? WHERE id = ?', [today, item.id]);
  }
  console.log(`ส่งอีเมลแจ้งเตือนแล้ว ${flagged.length} รายการ`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('ผิดพลาด:', err.message);
    process.exit(1); // ให้ GitHub ถือว่า run ล้มเหลว และแจ้งเตือนทางอีเมล
  });
}

module.exports = { classify, daysUntil, bangkokToday, buildEmailText, rowsToObjects };
