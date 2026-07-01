require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'mickidadyhamza@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.static(path.join(__dirname)));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || ADMIN_EMAIL,
    pass: process.env.EMAIL_PASS || process.env.ADMIN_PASSWORD
  },
  tls: { rejectUnauthorized: false }
});

// ==================== MONGODB SCHEMAS ====================
const UserSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  fullname: { type: String, required: true },
  phone: String,
  address: String,
  account_number: { type: String, unique: true, required: true },
  meter_number: String,
  user_type: { type: String, default: 'customer' },
  status: { type: String, default: 'active' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const BillSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  user_id: String,
  bill_number: { type: String, unique: true },
  billing_month: Date,
  previous_reading: Number,
  current_reading: Number,
  units_consumed: Number,
  rate_per_unit: Number,
  amount_due: Number,
  amount_paid: { type: Number, default: 0 },
  status: String,
  due_date: Date,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});
const Bill = mongoose.model('Bill', BillSchema);

const PaymentSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  bill_id: String,
  user_id: String,
  amount_paid: Number,
  payment_method: String,
  transaction_id: { type: String, unique: true },
  receipt_number: { type: String, unique: true },
  payment_date: { type: Date, default: Date.now },
  status: String,
  created_at: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', PaymentSchema);

const AnalyticsSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4 },
  user_id: String,
  event_type: String,
  event_data: mongoose.Schema.Types.Mixed,
  created_at: { type: Date, default: Date.now }
});
const Analytics = mongoose.model('Analytics', AnalyticsSchema);

// ==================== DATABASE INITIALIZATION ====================
let dbConnected = false;

async function initDb() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI is missing - server will start without database');
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    dbConnected = true;
    console.log('Database connected to MongoDB Atlas');

    mongoose.connection.on('disconnected', () => {
      dbConnected = false;
      console.log('MongoDB disconnected');
    });
    mongoose.connection.on('reconnected', () => {
      dbConnected = true;
      console.log('MongoDB reconnected');
    });
    mongoose.connection.on('error', () => {
      dbConnected = false;
    });

    const admin = await User.findOne({ email: ADMIN_EMAIL });
    if (!admin) {
      const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await new User({
        email: ADMIN_EMAIL,
        password: hashed,
        fullname: 'System Administrator',
        account_number: 'ADMIN-001',
        user_type: 'admin'
      }).save();
      console.log('Admin initialized');
    }
  } catch (err) {
    dbConnected = false;
    console.error('MongoDB connection failed:', err.message);
    console.warn('Server will continue without database - some features unavailable');
  }
}

// ==================== AUTH HELPERS ====================
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, user_type: user.user_type },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
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

// ==================== LOGGING ====================
async function logEvent(userId, eventType, eventData = {}) {
  try {
    await new Analytics({ user_id: userId, event_type: eventType, event_data: eventData }).save();
  } catch (e) { console.warn('Logging failed'); }
}

// ==================== DATABASE STATUS ====================
app.get('/api/db-status', (req, res) => {
  const state = mongoose.connection.readyState;
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({
    status: states[state] || 'unknown',
    connected: state === 1,
    dbName: mongoose.connection.name || null
  });
});

// ==================== DB CHECK MIDDLEWARE ====================
function requireDb(req, res, next) {
  if (!dbConnected) {
    return res.status(503).json({ error: 'Database ipo offline. Jaribu tena baadaye.', dbOffline: true });
  }
  next();
}

// ==================== AUTH ROUTES ====================
app.post('/api/auth/signup', requireDb, async (req, res) => {
  const { fullname, email, password, phone, address, account_number } = req.body;
  try {
    const exists = await User.findOne({ $or: [{ email }, { account_number }] });
    if (exists) return res.status(409).json({ error: 'Email or account number already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const newUser = await new User({ fullname, email, password: hashed, phone, address, account_number }).save();
    await logEvent(newUser.id, 'user_signup', { email });
    res.status(201).json({ message: 'Account created successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', requireDb, async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
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
      user_type: user.user_type,
      phone: user.phone,
      account_number: user.account_number,
      address: user.address
    }
  });
});

app.post('/api/auth/forgot-password', requireDb, async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: 'Email not found' });

  const token = jwt.sign({ email, purpose: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;

  await transporter.sendMail({
    from: ADMIN_EMAIL,
    to: email,
    subject: 'Password Reset Request',
    html: `<p>Use the link below to reset your password (valid for 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
  });

  await logEvent(user.id, 'password_reset_requested', { email });
  res.json({ message: 'Reset link sent to your email' });
});

app.post('/api/auth/reset-password', requireDb, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose !== 'reset') throw new Error('Invalid token');

    const hashed = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate(
      { email: payload.email },
      { password: hashed, updated_at: new Date() }
    );
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token' });
  }
});

// ==================== USER ROUTES ====================
app.get('/api/profile', authenticateToken, async (req, res) => {
  const user = await User.findOne({ id: req.user.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.id,
    email: user.email,
    fullname: user.fullname,
    user_type: user.user_type,
    phone: user.phone,
    account_number: user.account_number,
    address: user.address
  });
});

// ==================== BILLING ROUTES ====================
app.get('/api/bills', authenticateToken, async (req, res) => {
  const { year } = req.query;
  const query = { user_id: req.user.id };

  if (year) {
    const startDate = new Date(parseInt(year), 0, 1);
    const endDate = new Date(parseInt(year) + 1, 0, 1);
    query.billing_month = { $gte: startDate, $lt: endDate };
  }

  const bills = await Bill.find(query).sort({ billing_month: -1 });

  const billsWithUser = await Promise.all(bills.map(async (bill) => {
    const user = await User.findOne({ id: bill.user_id });
    return {
      ...bill.toObject(),
      fullname: user ? user.fullname : 'Unknown',
      account_number: user ? user.account_number : 'N/A'
    };
  }));

  res.json(billsWithUser);
});

app.get('/api/bills/:billId', authenticateToken, async (req, res) => {
  const bill = await Bill.findOne({ id: req.params.billId, user_id: req.user.id });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const payments = await Payment.find({ bill_id: req.params.billId });
  res.json({ bill, payments });
});

// Get yearly summary for a user
app.get('/api/bills/summary/yearly', authenticateToken, async (req, res) => {
  const { year } = req.query;
  const currentYear = year ? parseInt(year) : new Date().getFullYear();
  const startDate = new Date(currentYear, 0, 1);
  const endDate = new Date(currentYear + 1, 0, 1);

  const bills = await Bill.find({
    user_id: req.user.id,
    billing_month: { $gte: startDate, $lt: endDate }
  }).sort({ billing_month: 1 });

  const months = [];
  for (let m = 0; m < 12; m++) {
    const monthBills = bills.filter(b => new Date(b.billing_month).getMonth() === m);
    const totalDue = monthBills.reduce((s, b) => s + b.amount_due, 0);
    const totalPaid = monthBills.reduce((s, b) => s + b.amount_paid, 0);
    months.push({
      month: m,
      monthName: new Date(currentYear, m).toLocaleString('sw-TZ', { month: 'long' }),
      bills: monthBills,
      totalDue,
      totalPaid,
      status: monthBills.length === 0 ? 'no_bill' : totalPaid >= totalDue ? 'paid' : 'pending'
    });
  }

  res.json({
    year: currentYear,
    totalBills: bills.length,
    totalDue: bills.reduce((s, b) => s + b.amount_due, 0),
    totalPaid: bills.reduce((s, b) => s + b.amount_paid, 0),
    months
  });
});

// ==================== PAYMENT ROUTES ====================
app.post('/api/payments', authenticateToken, async (req, res) => {
  const { billId, amountPaid, paymentMethod } = req.body;

  const bill = await Bill.findOne({ id: billId, user_id: req.user.id });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  const payment = await new Payment({
    bill_id: billId,
    user_id: req.user.id,
    amount_paid: amountPaid,
    payment_method: paymentMethod || 'manual',
    transaction_id: `TXN-${uuidv4().slice(0, 12)}`,
    receipt_number: `RCP-${Date.now()}`,
    status: 'successful'
  }).save();

  bill.amount_paid += Number(amountPaid);
  bill.status = bill.amount_paid >= bill.amount_due ? 'paid' : 'partially_paid';
  await bill.save();

  await logEvent(req.user.id, 'payment_created', {
    billId,
    amountPaid,
    receiptNumber: payment.receipt_number
  });
  res.json({ message: 'Payment recorded', receiptNumber: payment.receipt_number });
});

app.get('/api/receipt/:paymentOrBillId', authenticateToken, async (req, res) => {
  const payment = await Payment.findOne({
    $or: [{ id: req.params.paymentOrBillId }, { bill_id: req.params.paymentOrBillId }],
    user_id: req.user.id
  }).sort({ payment_date: -1 });

  if (!payment) return res.status(404).json({ error: 'Receipt not found' });

  const bill = await Bill.findOne({ id: payment.bill_id });
  const user = await User.findOne({ id: req.user.id });
  res.send(generateReceiptHTML({
    ...payment._doc,
    bill_number: bill ? bill.bill_number : 'N/A',
    fullname: user ? user.fullname : 'N/A',
    email: user ? user.email : 'N/A'
  }));
});

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const users = await User.find({ user_type: 'customer' }).sort({ created_at: -1 });
  res.json(users);
});

app.get('/api/admin/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const user = await User.findOne({ id: req.params.userId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const bills = await Bill.find({ user_id: req.params.userId }).sort({ billing_month: -1 });
  const payments = await Payment.find({ user_id: req.params.userId }).sort({ payment_date: -1 }).limit(20);
  res.json({ user, recentBills: bills, recentPayments: payments });
});

// Admin: Update user info
app.put('/api/admin/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const { fullname, email, phone, address, account_number, meter_number } = req.body;
  const updates = {};
  if (fullname) updates.fullname = fullname;
  if (email) updates.email = email;
  if (phone) updates.phone = phone;
  if (address) updates.address = address;
  if (account_number) updates.account_number = account_number;
  if (meter_number) updates.meter_number = meter_number;
  updates.updated_at = new Date();

  const user = await User.findOneAndUpdate({ id: req.params.userId }, updates, { new: true });
  if (!user) return res.status(404).json({ error: 'User not found' });

  await logEvent(req.user.id, 'user_updated', { userId: req.params.userId, updates });
  res.json({ message: 'User updated successfully', user });
});

app.put('/api/admin/users/:userId/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  await User.findOneAndUpdate({ id: req.params.userId }, { status, updated_at: new Date() });
  await logEvent(req.user.id, 'user_status_updated', { userId: req.params.userId, status });
  res.json({ message: 'User status updated' });
});

// Admin: Create bill
app.post('/api/admin/bills', authenticateToken, requireAdmin, async (req, res) => {
  const { userId, previousReading, currentReading, ratePerUnit, billingMonth } = req.body;
  const units = currentReading - previousReading;

  const billDate = billingMonth ? new Date(billingMonth) : new Date();

  const bill = await new Bill({
    user_id: userId,
    bill_number: `BIL-${Date.now()}`,
    billing_month: billDate,
    previous_reading: previousReading,
    current_reading: currentReading,
    units_consumed: units,
    rate_per_unit: ratePerUnit || 2000,
    amount_due: units * (ratePerUnit || 2000),
    status: 'pending',
    due_date: new Date(billDate.getTime() + 30 * 24 * 60 * 60 * 1000)
  }).save();

  await logEvent(req.user.id, 'bill_created', { userId, billNumber: bill.bill_number });
  res.status(201).json({ message: 'Bill created', billNumber: bill.bill_number, bill });
});

// Admin: Edit bill
app.put('/api/admin/bills/:billId', authenticateToken, requireAdmin, async (req, res) => {
  const { previousReading, currentReading, ratePerUnit, billingMonth, status, amount_paid } = req.body;
  const bill = await Bill.findOne({ id: req.params.billId });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  if (previousReading !== undefined) bill.previous_reading = previousReading;
  if (currentReading !== undefined) bill.current_reading = currentReading;
  if (ratePerUnit !== undefined) bill.rate_per_unit = ratePerUnit;
  if (billingMonth) bill.billing_month = new Date(billingMonth);
  if (status) bill.status = status;
  if (amount_paid !== undefined) bill.amount_paid = amount_paid;

  if (previousReading !== undefined || currentReading !== undefined || ratePerUnit !== undefined) {
    bill.units_consumed = bill.current_reading - bill.previous_reading;
    bill.amount_due = bill.units_consumed * bill.rate_per_unit;
  }

  bill.updated_at = new Date();
  await bill.save();

  await logEvent(req.user.id, 'bill_updated', { billId: req.params.billId });
  res.json({ message: 'Bill updated successfully', bill });
});

// Admin: Delete bill
app.delete('/api/admin/bills/:billId', authenticateToken, requireAdmin, async (req, res) => {
  const bill = await Bill.findOneAndDelete({ id: req.params.billId });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  await logEvent(req.user.id, 'bill_deleted', { billId: req.params.billId });
  res.json({ message: 'Bill deleted successfully' });
});

// Admin: Get all bills with user info
app.get('/api/admin/all-bills', authenticateToken, requireAdmin, async (req, res) => {
  const { year, userId } = req.query;
  const query = {};

  if (userId) query.user_id = userId;
  if (year) {
    const startDate = new Date(parseInt(year), 0, 1);
    const endDate = new Date(parseInt(year) + 1, 0, 1);
    query.billing_month = { $gte: startDate, $lt: endDate };
  }

  const bills = await Bill.find(query).sort({ billing_month: -1 });

  const billsWithUser = await Promise.all(bills.map(async (bill) => {
    const user = await User.findOne({ id: bill.user_id });
    return {
      ...bill.toObject(),
      fullname: user ? user.fullname : 'Unknown',
      account_number: user ? user.account_number : 'N/A',
      phone: user ? user.phone : 'N/A'
    };
  }));

  res.json(billsWithUser);
});

// Admin: Get user yearly summary
app.get('/api/admin/users/:userId/yearly', authenticateToken, requireAdmin, async (req, res) => {
  const { year } = req.query;
  const currentYear = year ? parseInt(year) : new Date().getFullYear();
  const startDate = new Date(currentYear, 0, 1);
  const endDate = new Date(currentYear + 1, 0, 1);

  const user = await User.findOne({ id: req.params.userId });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const bills = await Bill.find({
    user_id: req.params.userId,
    billing_month: { $gte: startDate, $lt: endDate }
  }).sort({ billing_month: 1 });

  const months = [];
  for (let m = 0; m < 12; m++) {
    const monthBills = bills.filter(b => new Date(b.billing_month).getMonth() === m);
    const totalDue = monthBills.reduce((s, b) => s + b.amount_due, 0);
    const totalPaid = monthBills.reduce((s, b) => s + b.amount_paid, 0);
    months.push({
      month: m,
      monthName: new Date(currentYear, m).toLocaleString('sw-TZ', { month: 'long' }),
      bills: monthBills,
      totalDue,
      totalPaid,
      status: monthBills.length === 0 ? 'no_bill' : totalPaid >= totalDue ? 'paid' : 'pending'
    });
  }

  res.json({
    user: { id: user.id, fullname: user.fullname, account_number: user.account_number, phone: user.phone },
    year: currentYear,
    totalBills: bills.length,
    totalDue: bills.reduce((s, b) => s + b.amount_due, 0),
    totalPaid: bills.reduce((s, b) => s + b.amount_paid, 0),
    months
  });
});

app.get('/api/admin/analytics', authenticateToken, requireAdmin, async (req, res) => {
  const totalUsers = await User.countDocuments({ user_type: 'customer' });
  const payments = await Payment.find({ status: 'successful' });
  const totalRevenue = payments.reduce((sum, p) => sum + p.amount_paid, 0);
  const pendingBills = await Bill.countDocuments({ status: { $in: ['pending', 'partially_paid'] } });
  const totalBills = await Bill.countDocuments();
  const paidBills = await Bill.countDocuments({ status: 'paid' });
  const recentActivities = await Analytics.find().sort({ created_at: -1 }).limit(50);
  res.json({ totalUsers, totalRevenue, pendingBills, totalBills, paidBills, recentActivities });
});

// ==================== PAGE ROUTES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin-dashboard.html')));
app.get('/records', (req, res) => res.sendFile(path.join(__dirname, 'records.html')));
app.get('/records.html', (req, res) => res.sendFile(path.join(__dirname, 'records.html')));
app.get('/user-bills', (req, res) => res.sendFile(path.join(__dirname, 'user-bills.html')));

app.get('/:page.html', (req, res) => {
  const target = path.join(__dirname, `${req.params.page}.html`);
  if (fs.existsSync(target)) return res.sendFile(target);
  return res.redirect('/');
});

// ==================== SERVER SETUP ====================
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Mickey Water running on http://localhost:${PORT}`);
    if (!dbConnected) console.warn('WARNING: Running without MongoDB - login/signup will not work');
  });
}).catch(err => {
  console.error('Database error:', err.message);
  app.listen(PORT, () => {
    console.log(`Mickey Water running on http://localhost:${PORT} (without database)`);
  });
});

function generateReceiptHTML(payment) {
  const amount = payment.amount_paid ? payment.amount_paid.toLocaleString() : '0';
  const date = payment.payment_date ? new Date(payment.payment_date).toLocaleDateString() : 'N/A';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${payment.receipt_number || 'N/A'}</title><style>body{font-family:Arial,sans-serif;background:#f7fafc;margin:0;padding:30px}body>.receipt{max-width:700px;margin:auto;background:#fff;padding:30px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.08)}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px}.header h1{font-size:24px;color:#1f2937}.section{margin-bottom:20px}.section h2{margin-bottom:12px;color:#111827;font-size:16px}.row{display:flex;justify-content:space-between;margin-bottom:10px}.label{color:#6b7280}.value{font-weight:700}.status{color:#10b981;font-weight:700}.amount{color:#0f766e;font-size:18px;font-weight:700}</style></head><body><div class="receipt"><div class="header"><div><h1>MICKEY WATER</h1><p>Official Payment Receipt</p></div><div><span>Receipt #${payment.receipt_number || 'N/A'}</span></div></div><div class="section"><h2>Customer</h2><div class="row"><span class="label">Name</span><span class="value">${payment.fullname || 'N/A'}</span></div><div class="row"><span class="label">Email</span><span class="value">${payment.email || 'N/A'}</span></div><div class="row"><span class="label">Bill #</span><span class="value">${payment.bill_number || 'N/A'}</span></div></div><div class="section"><h2>Payment</h2><div class="row"><span class="label">Amount Paid</span><span class="amount">TZS ${amount}</span></div><div class="row"><span class="label">Transaction ID</span><span class="value">${payment.transaction_id || 'N/A'}</span></div><div class="row"><span class="label">Date</span><span class="value">${date}</span></div></div><div class="section"><h2>Status</h2><div class="row"><span class="label">Payment Status</span><span class="status">${(payment.status || 'N/A').toUpperCase()}</span></div></div><div style="text-align:center;margin-top:30px;color:#6b7280;font-size:14px;">Thank you for paying your bill with Mickey Water.</div></div></body></html>`;
}
