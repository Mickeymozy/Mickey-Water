require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { v4: uuidv4 } = require('uuid');

const app = express();
const DB_FILE = path.join(__dirname, 'database.sqlite');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'mickidadyhamza@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.static(path.join(__dirname)));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: ADMIN_EMAIL,
    pass: process.env.ADMIN_PASSWORD || ADMIN_PASSWORD
  }
});

let db;

async function initDb() {
  db = await open({ filename: DB_FILE, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      fullname TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      account_number TEXT UNIQUE NOT NULL,
      meter_number TEXT,
      user_type TEXT NOT NULL DEFAULT 'customer',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bill_number TEXT UNIQUE NOT NULL,
      billing_month TEXT NOT NULL,
      previous_reading INTEGER NOT NULL,
      current_reading INTEGER NOT NULL,
      units_consumed INTEGER NOT NULL,
      rate_per_unit REAL NOT NULL,
      amount_due REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      due_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount_paid REAL NOT NULL,
      payment_method TEXT,
      transaction_id TEXT UNIQUE,
      receipt_number TEXT UNIQUE NOT NULL,
      payment_date TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(bill_id) REFERENCES bills(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS analytics (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  const adminExists = await db.get('SELECT id FROM users WHERE email = ?', ADMIN_EMAIL);
  if (!adminExists) {
    const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const adminId = uuidv4();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO users (id, email, password, fullname, account_number, user_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, ?)`,
      [adminId, ADMIN_EMAIL, hashed, 'System Administrator', 'ADMIN-001', now, now]
    );
    console.log('✅ Admin user initialized:', ADMIN_EMAIL);
  }
}

function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, user_type: user.user_type }, JWT_SECRET, { expiresIn: '7d' });
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.user_type !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
  }
  next();
}

async function logEvent(userId, eventType, eventData = {}) {
  await db.run(
    'INSERT INTO analytics (id, user_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), userId || null, eventType, JSON.stringify(eventData), new Date().toISOString()]
  );
}

app.post('/api/auth/signup', async (req, res) => {
  const { fullname, email, password, phone, address, account_number } = req.body;
  if (!fullname || !email || !password || !account_number) {
    return res.status(400).json({ error: 'All required fields must be provided' });
  }

  const exists = await db.get('SELECT id FROM users WHERE email = ? OR account_number = ?', [email, account_number]);
  if (exists) return res.status(409).json({ error: 'Email or account number already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  const userId = uuidv4();
  await db.run(
    'INSERT INTO users (id, email, password, fullname, phone, address, account_number, user_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, email, hashed, fullname, phone || null, address || null, account_number, 'customer', 'active', now, now]
  );
  await logEvent(userId, 'user_signup', { email });

  res.status(201).json({ message: 'Account created successfully. Please login.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = generateToken(user);
  await logEvent(user.id, 'user_login', { email });

  res.json({
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      email: user.email,
      fullname: user.fullname,
      user_type: user.user_type
    }
  });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (!user) return res.status(404).json({ error: 'Email not found' });

  const token = jwt.sign({ email, purpose: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;

  await transporter.sendMail({
    from: ADMIN_EMAIL,
    to: email,
    subject: 'Password Reset Request',
    html: `<p>Use the link below to reset your password (valid for 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
  });

  await logEvent(user.id, 'password_reset_requested', { email });
  res.json({ message: 'Reset link sent to your email' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose !== 'reset') throw new Error('Invalid token');
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.run('UPDATE users SET password = ?, updated_at = ? WHERE email = ?', [hashed, new Date().toISOString(), payload.email]);
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token' });
  }
});

app.get('/api/bills', authenticateToken, async (req, res) => {
  const bills = await db.all('SELECT * FROM bills WHERE user_id = ? ORDER BY billing_month DESC', [req.user.id]);
  res.json(bills);
});

app.get('/api/bills/:billId', authenticateToken, async (req, res) => {
  const bill = await db.get('SELECT b.*, u.email, u.fullname, u.address FROM bills b JOIN users u ON b.user_id = u.id WHERE b.id = ? AND b.user_id = ?', [req.params.billId, req.user.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const payments = await db.all('SELECT * FROM payments WHERE bill_id = ?', [req.params.billId]);
  res.json({ bill, payments });
});

app.post('/api/payments', authenticateToken, async (req, res) => {
  const { billId, amountPaid, paymentMethod } = req.body;
  if (!billId || !amountPaid) return res.status(400).json({ error: 'Bill ID and amount are required' });

  const bill = await db.get('SELECT * FROM bills WHERE id = ? AND user_id = ?', [billId, req.user.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  const paymentId = uuidv4();
  const receiptNumber = `RCP-${Date.now()}`;
  const transactionId = `TXN-${uuidv4().slice(0, 12)}`;
  const now = new Date().toISOString();

  await db.run(
    'INSERT INTO payments (id, bill_id, user_id, amount_paid, payment_method, transaction_id, receipt_number, payment_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [paymentId, billId, req.user.id, amountPaid, paymentMethod || 'manual', transactionId, receiptNumber, now, 'successful', now]
  );

  const newPaid = bill.amount_paid + Number(amountPaid);
  const status = newPaid >= bill.amount_due ? 'paid' : 'partially_paid';
  await db.run('UPDATE bills SET amount_paid = ?, status = ? WHERE id = ?', [newPaid, status, billId]);

  await logEvent(req.user.id, 'payment_created', { billId, amountPaid, receiptNumber });
  res.json({ message: 'Payment recorded successfully', receiptNumber });
});

app.get('/api/receipt/:paymentOrBillId', authenticateToken, async (req, res) => {
  const { paymentOrBillId } = req.params;
  let payment = await db.get('SELECT p.*, b.bill_number, b.amount_due, u.email, u.fullname FROM payments p JOIN bills b ON p.bill_id = b.id JOIN users u ON p.user_id = u.id WHERE p.id = ? AND p.user_id = ?', [paymentOrBillId, req.user.id]);

  if (!payment) {
    const bill = await db.get('SELECT id FROM bills WHERE id = ? AND user_id = ?', [paymentOrBillId, req.user.id]);
    if (bill) {
      payment = await db.get('SELECT p.*, b.bill_number, b.amount_due, u.email, u.fullname FROM payments p JOIN bills b ON p.bill_id = b.id JOIN users u ON p.user_id = u.id WHERE p.bill_id = ? AND p.user_id = ? ORDER BY p.payment_date DESC LIMIT 1', [bill.id, req.user.id]);
    }
  }

  if (!payment) return res.status(404).json({ error: 'Receipt not found' });
  res.send(generateReceiptHTML(payment));
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const users = await db.all('SELECT id, email, fullname, phone, account_number, user_type, status, created_at FROM users WHERE user_type = "customer" ORDER BY created_at DESC');
  res.json(users);
});

app.get('/api/admin/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const bills = await db.all('SELECT * FROM bills WHERE user_id = ? ORDER BY billing_month DESC LIMIT 12', [req.params.userId]);
  const payments = await db.all('SELECT * FROM payments WHERE user_id = ? ORDER BY payment_date DESC LIMIT 20', [req.params.userId]);
  res.json({ user, recentBills: bills, recentPayments: payments });
});

app.put('/api/admin/users/:userId/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['active', 'inactive', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, new Date().toISOString(), req.params.userId]);
  await logEvent(req.user.id, 'user_status_updated', { userId: req.params.userId, status });
  res.json({ message: 'User status updated' });
});

app.post('/api/admin/bills', authenticateToken, requireAdmin, async (req, res) => {
  const { userId, previousReading, currentReading, ratePerUnit } = req.body;
  if (!userId || previousReading == null || currentReading == null) return res.status(400).json({ error: 'Required fields missing' });

  const units = currentReading - previousReading;
  const amountDue = units * (ratePerUnit || 50);
  const billId = uuidv4();
  const billNumber = `BIL-${Date.now()}`;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  const now = new Date().toISOString();

  await db.run(
    'INSERT INTO bills (id, user_id, bill_number, billing_month, previous_reading, current_reading, units_consumed, rate_per_unit, amount_due, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [billId, userId, billNumber, new Date().toISOString(), previousReading, currentReading, units, ratePerUnit || 50, amountDue, dueDate.toISOString().split('T')[0], 'pending', now]
  );

  await logEvent(req.user.id, 'bill_created', { userId, billNumber, amountDue });
  res.status(201).json({ message: 'Bill created successfully', billNumber, amountDue });
});

app.get('/api/admin/analytics', authenticateToken, requireAdmin, async (req, res) => {
  const totalUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE user_type = "customer"');
  const totalRevenue = await db.get('SELECT SUM(amount_paid) as total FROM payments WHERE status = "successful"');
  const pendingBills = await db.get('SELECT COUNT(*) as count FROM bills WHERE status IN ("pending", "partially_paid")');
  const recentActivities = await db.all('SELECT * FROM analytics ORDER BY created_at DESC LIMIT 50');
  res.json({ totalUsers: totalUsers.count, totalRevenue: totalRevenue.total || 0, pendingBills: pendingBills.count, recentActivities });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'reset-password.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

app.get('/records', (req, res) => {
  res.sendFile(path.join(__dirname, 'records.html'));
});

app.get('/:page.html', (req, res) => {
  const target = path.join(__dirname, `${req.params.page}.html`);
  if (fs.existsSync(target)) return res.sendFile(target);
  return res.redirect('/');
});

process.on('uncaughtException', (err) => console.error('🔥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled Rejection:', reason));

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 SQLite database: ${DB_FILE}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

function generateReceiptHTML(payment) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${payment.receipt_number}</title><style>body{font-family:Arial,sans-serif;background:#f7fafc;margin:0;padding:30px}body>.receipt{max-width:700px;margin:auto;background:#fff;padding:30px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.08)}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px}.header h1{font-size:24px;color:#1f2937}.section{margin-bottom:20px}.section h2{margin-bottom:12px;color:#111827;font-size:16px}.row{display:flex;justify-content:space-between;margin-bottom:10px}.label{color:#6b7280}.value{font-weight:700}.status{color:#10b981;font-weight:700}.amount{color:#0f766e;font-size:18px;font-weight:700}</style></head><body><div class="receipt"><div class="header"><div><h1>MICKEY WATER</h1><p>Official Payment Receipt</p></div><div><span>Receipt #${payment.receipt_number}</span></div></div><div class="section"><h2>Customer</h2><div class="row"><span class="label">Name</span><span class="value">${payment.fullname}</span></div><div class="row"><span class="label">Email</span><span class="value">${payment.email}</span></div><div class="row"><span class="label">Bill #</span><span class="value">${payment.bill_number}</span></div></div><div class="section"><h2>Payment</h2><div class="row"><span class="label">Amount Paid</span><span class="amount">TZS ${payment.amount_paid.toLocaleString()}</span></div><div class="row"><span class="label">Transaction ID</span><span class="value">${payment.transaction_id}</span></div><div class="row"><span class="label">Date</span><span class="value">${new Date(payment.payment_date).toLocaleDateString()}</span></div></div><div class="section"><h2>Status</h2><div class="row"><span class="label">Payment Status</span><span class="status">${payment.status.toUpperCase()}</span></div></div><div style="text-align:center;margin-top:30px;color:#6b7280;font-size:14px;">Thank you for paying your bill with Mickey Water.</div></div></body></html>`;
}
