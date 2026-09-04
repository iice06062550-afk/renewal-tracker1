// server.js
// ระบบติดตามการต่ออายุ — Node.js + Express + Turso (cloud SQLite) + Resend (ส่งอีเมล)
// -----------------------------------------------------------------------
// รัน: npm install แล้ว npm start
//
// หมายเหตุสำคัญ #1: ใช้ Turso (ฐานข้อมูลบนคลาวด์) แทนไฟล์ในเครื่อง เพราะ Render free tier
// มี "ephemeral filesystem" — ไฟล์ที่เขียนไว้ในเครื่องจะหายทุกครั้งที่ restart/หลับ-ตื่น
//
// หมายเหตุสำคัญ #2: ใช้ Resend (ส่งอีเมลผ่าน HTTPS API) แทน Nodemailer+SMTP เพราะ Render
// free tier บล็อกการเชื่อมต่อ SMTP (พอร์ต 25/465/587) ทั้งหมดตั้งแต่ปลายปี 2568
// ทำให้ nodemailer ค้างไม่มีวันเชื่อมต่อสำเร็จ Resend ส่งผ่าน HTTPS (พอร์ต 443) จึงไม่โดนบล็อก

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@tursodatabase/serverless/compat');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const CRON_SECRET = process.env.CRON_SECRET || 'change-this-secret';

// ---------- Turso client ----------
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const DEFAULT_ITEMS = [
  { id: 'antivirus', name: 'ต่ออายุ Anti Virus', dueDate: null, note: '58 license — ต่ออายุทุกปี (พ.ศ. 2569), พบยอดในแผนเดือน 3 และ 7' },
  { id: 'ma-ups', name: 'ต่ออายุ MA UPS', dueDate: '2027-01-17', note: 'จากเอกสารเดิม: 17/1/2569' },
  { id: 'forticloud', name: 'ต่ออายุ FortiCloud', dueDate: '2027-04-17', note: 'จากเอกสารเดิม: 17/4/2569' },
  { id: 'ma-fortigate', name: 'ต่ออายุ MA Fortigate', dueDate: '2027-04-17', note: 'จากเอกสารเดิม: 17/4/2569' },
  { id: 'email', name: 'ต่ออายุ E-Mail', dueDate: '2027-01-31', note: 'จากเอกสารเดิม: 31/1/2569' },
  { id: 'hosting', name: 'ต่ออายุ Hosting', dueDate: '2026-12-01', note: 'จากเอกสารเดิม: 1/12/2569' },
  { id: 'ssl-trffeedmill', name: 'ต่ออายุ SSL trffeedmill', dueDate: '2027-07-01', note: 'จากเอกสารเดิม: 1/7/2569' },
  { id: 'ssl-trffeed', name: 'ต่ออายุ SSL trffeed', dueDate: '2028-01-26', note: 'จากเอกสารเดิม: 26/1/2571' },
  { id: 'domain-trffeedmill', name: 'ต่ออายุ Domain trffeedmill', dueDate: '2031-12-31', note: 'จากเอกสารเดิม: หมดปี พ.ศ. 2574 (ไม่ระบุวันแน่นอน)' },
  { id: 'domain-trffeed', name: 'ต่ออายุ Domain trffeed', dueDate: '2027-07-01', note: 'จากเอกสารเดิม: 1/7/2569' },
  { id: 'line-api', name: 'ต่ออายุ Line API', dueDate: '2027-07-01', note: 'จากเอกสารเดิม: หมด 1/7/2569' },
  { id: 'zoom', name: 'ต่ออายุ Zoom', dueDate: '2027-07-14', note: 'จากเอกสารเดิม: 14/7/2569' },
];
const DEFAULT_AUTH = { username: 'admin', password: 'renew2026' };

// ---------- Helper: แปลงผลลัพธ์จาก Turso ให้เป็น object ที่มีชื่อ key แน่นอน ----------
// (กันปัญหา driver บางเวอร์ชันคืนแถวมาเป็น array แทน object ทำให้เข้าถึงด้วยชื่อคอลัมน์ไม่ได้)
function rowsToObjects(result) {
  const columns = result.columns || [];
  return result.rows.map(row => {
    if (Array.isArray(row)) {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    }
    if (columns.length === 0) return row; // ไม่มี column list ให้ใช้ ก็คืน row ตรงๆ
    const obj = {};
    columns.forEach(col => { obj[col] = row[col]; });
    return obj;
  });
}

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dueDate TEXT,
      note TEXT,
      renewed INTEGER NOT NULL DEFAULT 0,
      lastNotifiedDate TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  const countRes = await db.execute('SELECT COUNT(*) AS c FROM items');
  const count = rowsToObjects(countRes)[0].c;
  if (count === 0) {
    for (const it of DEFAULT_ITEMS) {
      await db.execute(
        'INSERT INTO items (id, name, dueDate, note, renewed) VALUES (?, ?, ?, ?, 0)',
        [it.id, it.name, it.dueDate, it.note]
      );
    }
  }

  const authRes = await db.execute('SELECT value FROM settings WHERE key = ?', ['auth']);
  const authRows = rowsToObjects(authRes);
  if (authRows.length === 0) {
    await db.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?)',
      ['auth', JSON.stringify(DEFAULT_AUTH)]
    );
  }
}

async function getAuth() {
  const res = await db.execute('SELECT value FROM settings WHERE key = ?', ['auth']);
  return JSON.parse(rowsToObjects(res)[0].value);
}
async function setAuth(auth) {
  await db.execute(
    'UPDATE settings SET value = ? WHERE key = ?',
    [JSON.stringify(auth), 'auth']
  );
}

// ---------- Session แบบง่าย (เก็บใน memory ตัวเดียว — พอสำหรับผู้ดูแลคนเดียว) ----------
let activeToken = null;

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || token !== activeToken) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  next();
}

// ---------- Auth routes ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const auth = await getAuth();
    if (username === auth.username && password === auth.password) {
      activeToken = crypto.randomBytes(16).toString('hex');
      return res.json({ token: activeToken });
    }
    res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', requireAuth, (req, res) => {
  activeToken = null;
  res.json({ ok: true });
});

app.post('/api/change-account', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body;
    const auth = await getAuth();
    if (currentPassword !== auth.password) {
      return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    }
    await setAuth({
      username: (newUsername && newUsername.trim()) || auth.username,
      password: newPassword || auth.password,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Items routes ----------
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM items');
    res.json(rowsToObjects(result).map(r => ({ ...r, renewed: !!r.renewed })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/items', requireAuth, async (req, res) => {
  try {
    const { name, dueDate, note } = req.body;
    if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อรายการ' });
    const id = 'item-' + Date.now();
    await db.execute(
      'INSERT INTO items (id, name, dueDate, note, renewed) VALUES (?, ?, ?, ?, 0)',
      [id, name, dueDate || null, note || 'เพิ่มเอง']
    );
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/items/:id', requireAuth, async (req, res) => {
  try {
    const { dueDate, renewed } = req.body;
    if (dueDate !== undefined) {
      await db.execute('UPDATE items SET dueDate = ? WHERE id = ?', [dueDate || null, req.params.id]);
    }
    if (renewed !== undefined) {
      await db.execute('UPDATE items SET renewed = ? WHERE id = ?', [renewed ? 1 : 0, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:id', requireAuth, async (req, res) => {
  try {
    await db.execute('DELETE FROM items WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/items/reset', requireAuth, async (req, res) => {
  try {
    await db.execute('DELETE FROM items');
    for (const it of DEFAULT_ITEMS) {
      await db.execute(
        'INSERT INTO items (id, name, dueDate, note, renewed) VALUES (?, ?, ?, ?, 0)',
        [it.id, it.name, it.dueDate, it.note]
      );
    }
    const result = await db.execute('SELECT * FROM items');
    res.json(rowsToObjects(result).map(r => ({ ...r, renewed: !!r.renewed })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cron endpoint: เรียกจาก cron-job.org ทุกวัน เพื่อเช็ค + ส่งอีเมล ----------
app.get('/api/cron/check-renewals', async (req, res) => {
  if (req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: 'invalid secret' });
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);

    const result = await db.execute('SELECT * FROM items WHERE renewed = 0');
    const overdue = [];
    const dueSoon = [];

    rowsToObjects(result).forEach(item => {
      if (!item.dueDate) return;
      if (item.lastNotifiedDate === todayStr) return; // กันส่งซ้ำวันเดียวกัน

      const due = new Date(item.dueDate + 'T00:00:00');
      const daysLeft = Math.round((due - today) / 86400000);

      if (daysLeft < 0) overdue.push({ ...item, daysLeft });
      else if (daysLeft <= 7) dueSoon.push({ ...item, daysLeft });
    });

    const flagged = [...overdue, ...dueSoon];
    if (flagged.length === 0) {
      return res.json({ sent: false, message: 'ไม่มีรายการที่ต้องแจ้งเตือนวันนี้' });
    }

    await sendReminderEmail(overdue, dueSoon);
    for (const item of flagged) {
      await db.execute('UPDATE items SET lastNotifiedDate = ? WHERE id = ?', [todayStr, item.id]);
    }
    res.json({ sent: true, count: flagged.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendReminderEmail(overdue, dueSoon) {
  const lines = [];
  if (overdue.length) {
    lines.push('=== เลยกำหนดแล้ว ===');
    overdue.forEach(it => lines.push(`- ${it.name}: เลยกำหนดมา ${Math.abs(it.daysLeft)} วัน (ครบกำหนด ${it.dueDate})`));
  }
  if (dueSoon.length) {
    lines.push('', '=== ใกล้ครบกำหนด ===');
    dueSoon.forEach(it => lines.push(`- ${it.name}: เหลืออีก ${it.daysLeft} วัน (ครบกำหนด ${it.dueDate})`));
  }

  // ส่งผ่าน Resend HTTPS API (พอร์ต 443) แทน SMTP เพื่อไม่ให้โดน Render บล็อก
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
      text: lines.join('\n'),
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errBody}`);
  }
}

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Renewal tracker running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
