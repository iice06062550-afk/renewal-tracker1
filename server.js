// server.js
// ระบบติดตามการต่ออายุ — Node.js + Express + JSON file storage + Nodemailer
// -----------------------------------------------------------------------
// รัน: npm install แล้ว npm start (ดูวิธี deploy ขึ้น Render ในข้อความแชท)
//
// หมายเหตุ: ใช้ไฟล์ JSON (data.json) เก็บข้อมูลแทน SQLite เพราะ SQLite แบบ native
// (better-sqlite3) ต้อง compile โค้ด C++ ตอนติดตั้ง ซึ่งพังบ่อยบน hosting ฟรีบางเจ้า
// ไฟล์ JSON เก็บถาวรได้เหมือนกัน ไม่ต้อง compile อะไรเลย ติดตั้งง่ายกว่ามาก

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const CRON_SECRET = process.env.CRON_SECRET || 'change-this-secret';
const DB_FILE = path.join(__dirname, 'data.json');

const DEFAULT_ITEMS = [
  { id: 'antivirus', name: 'ต่ออายุ Anti Virus', dueDate: null, note: '58 license — ต่ออายุทุกปี (พ.ศ. 2569), พบยอดในแผนเดือน 3 และ 7', renewed: false, lastNotifiedDate: null },
  { id: 'ma-ups', name: 'ต่ออายุ MA UPS', dueDate: '2027-01-17', note: 'จากเอกสารเดิม: 17/1/2569', renewed: false, lastNotifiedDate: null },
  { id: 'forticloud', name: 'ต่ออายุ FortiCloud', dueDate: '2027-04-17', note: 'จากเอกสารเดิม: 17/4/2569', renewed: false, lastNotifiedDate: null },
  { id: 'ma-fortigate', name: 'ต่ออายุ MA Fortigate', dueDate: '2027-04-17', note: 'จากเอกสารเดิม: 17/4/2569', renewed: false, lastNotifiedDate: null },
  { id: 'email', name: 'ต่ออายุ E-Mail', dueDate: '2027-01-31', note: 'จากเอกสารเดิม: 31/1/2569', renewed: false, lastNotifiedDate: null },
  { id: 'hosting', name: 'ต่ออายุ Hosting', dueDate: '2026-12-01', note: 'จากเอกสารเดิม: 1/12/2569', renewed: false, lastNotifiedDate: null },
  { id: 'ssl-trffeedmill', name: 'ต่ออายุ SSL trffeedmill', dueDate: '2027-07-01', note: 'จากเอกสารเดิม: 1/7/2569', renewed: false, lastNotifiedDate: null },
  { id: 'ssl-trffeed', name: 'ต่ออายุ SSL trffeed', dueDate: '2028-01-26', note: 'จากเอกสารเดิม: 26/1/2571', renewed: false, lastNotifiedDate: null },
  { id: 'domain-trffeedmill', name: 'ต่ออายุ Domain trffeedmill', dueDate: '2031-12-31', note: 'จากเอกสารเดิม: หมดปี พ.ศ. 2574 (ไม่ระบุวันแน่นอน)', renewed: false, lastNotifiedDate: null },
  { id: 'domain-trffeed', name: 'ต่ออายุ Domain trffeed', dueDate: '2027-07-01', note: 'จากเอกสารเดิม: 1/7/2569', renewed: false, lastNotifiedDate: null },
  { id: 'line-api', name: 'ต่ออายุ Line API', dueDate: '2027-07-01', note: 'จากเอกสารเดิม: หมด 1/7/2569', renewed: false, lastNotifiedDate: null },
  { id: 'zoom', name: 'ต่ออายุ Zoom', dueDate: '2027-07-14', note: 'จากเอกสารเดิม: 14/7/2569', renewed: false, lastNotifiedDate: null },
];
const DEFAULT_AUTH = { username: 'admin', password: 'renew2026' };

// ---------- ฐานข้อมูลแบบไฟล์ JSON (ไฟล์เดียว: data.json) ----------
function loadStore() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { items: DEFAULT_ITEMS, auth: DEFAULT_AUTH };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveStore(store) {
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

let store = loadStore();

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
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === store.auth.username && password === store.auth.password) {
    activeToken = crypto.randomBytes(16).toString('hex');
    return res.json({ token: activeToken });
  }
  res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.post('/api/logout', requireAuth, (req, res) => {
  activeToken = null;
  res.json({ ok: true });
});

app.post('/api/change-account', requireAuth, (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body;
  if (currentPassword !== store.auth.password) {
    return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  }
  store.auth = {
    username: (newUsername && newUsername.trim()) || store.auth.username,
    password: newPassword || store.auth.password,
  };
  saveStore(store);
  res.json({ ok: true });
});

// ---------- Items routes ----------
app.get('/api/items', requireAuth, (req, res) => {
  res.json(store.items);
});

app.post('/api/items', requireAuth, (req, res) => {
  const { name, dueDate, note } = req.body;
  if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อรายการ' });
  const item = {
    id: 'item-' + Date.now(),
    name,
    dueDate: dueDate || null,
    note: note || 'เพิ่มเอง',
    renewed: false,
    lastNotifiedDate: null,
  };
  store.items.push(item);
  saveStore(store);
  res.json({ id: item.id });
});

app.put('/api/items/:id', requireAuth, (req, res) => {
  const { dueDate, renewed } = req.body;
  const item = store.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'ไม่พบรายการ' });

  if (dueDate !== undefined) item.dueDate = dueDate || null;
  if (renewed !== undefined) item.renewed = !!renewed;
  saveStore(store);
  res.json({ ok: true });
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  store.items = store.items.filter(i => i.id !== req.params.id);
  saveStore(store);
  res.json({ ok: true });
});

app.post('/api/items/reset', requireAuth, (req, res) => {
  store.items = DEFAULT_ITEMS.map(it => ({ ...it }));
  saveStore(store);
  res.json(store.items);
});

// ---------- Cron endpoint: เรียกจาก cron-job.org ทุกวัน เพื่อเช็ค + ส่งอีเมล ----------
app.get('/api/cron/check-renewals', async (req, res) => {
  if (req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: 'invalid secret' });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  const overdue = [];
  const dueSoon = [];

  store.items.forEach(item => {
    if (item.renewed || !item.dueDate) return;
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

  try {
    await sendReminderEmail(overdue, dueSoon);
    flagged.forEach(f => {
      const item = store.items.find(i => i.id === f.id);
      if (item) item.lastNotifiedDate = todayStr;
    });
    saveStore(store);
    res.json({ sent: true, count: flagged.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendReminderEmail(overdue, dueSoon) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const lines = [];
  if (overdue.length) {
    lines.push('=== เลยกำหนดแล้ว ===');
    overdue.forEach(it => lines.push(`- ${it.name}: เลยกำหนดมา ${Math.abs(it.daysLeft)} วัน (ครบกำหนด ${it.dueDate})`));
  }
  if (dueSoon.length) {
    lines.push('', '=== ใกล้ครบกำหนด ===');
    dueSoon.forEach(it => lines.push(`- ${it.name}: เหลืออีก ${it.daysLeft} วัน (ครบกำหนด ${it.dueDate})`));
  }

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.NOTIFY_EMAIL || process.env.GMAIL_USER,
    subject: 'แจ้งเตือน: รายการที่ต้องต่ออายุ',
    text: lines.join('\n'),
  });
}

app.listen(PORT, () => {
  console.log(`Renewal tracker running on port ${PORT}`);
});

