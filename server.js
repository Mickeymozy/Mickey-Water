require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const compression = require('compression');
const crypto = require('crypto');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression({ threshold: 1024 }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Setup
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' },
  name: 'waterBillingSession'
}));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/water_billing';
let isMongoDBConnected = false;

mongoose.connect(MONGODB_URI)
  .then(() => { 
    isMongoDBConnected = true; 
    console.log('🟢 MongoDB Connected Successfully!'); 
  })
  .catch((err) => { 
    console.error('❌ MongoDB Connection Failed:', err.message); 
  });

// Schemas & Models
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const RecordSchema = new mongoose.Schema({
  date: String,
  name: String,
  phone: String,
  prev: Number,
  curr: Number,
  usage: Number,
  total: Number,
  createdAt: { type: Date, default: Date.now }
});
const Record = mongoose.model('Record', RecordSchema);

// Admin Configuration Baseline
const ADMIN_EMAIL = 'admin@waterbilling.com';
const ADMIN_PASS = 'admin123';

// Auth Middleware
const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }
  next();
};

// --- API ENDPOINTS ---

// 1. Signup Route
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required' });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'Email already registered' });

    const newUser = new User({ name, email, password });
    await newUser.save();

    res.status(201).json({ success: true, message: 'Registration successful!' });
  } catch (err) {
    res.status(500).json({ error: 'Signup failed: ' + err.message });
  }
});

// 2. Login Route
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Angalia kama ni Admin kwanza
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
      req.session.user = { id: 'admin_01', name: 'System Admin', email, role: 'admin' };
      return res.json({ success: true, redirect: '/records', user: req.session.user });
    }

    if (!isMongoDBConnected) return res.status(500).json({ error: 'Database is offline. Cannot authenticate.' });
    
    const user = await User.findOne({ email, password });
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });

    req.session.user = { id: user._id, name: user.name, email: user.email, role: 'user' };
    res.json({ success: true, redirect: '/records', user: req.session.user });
  } catch (err) {
    res.status(500).json({ error: 'Login server error' });
  }
});

// Admin Bypass Route
app.post('/api/admin-login', (req, res) => {
  req.session.user = { id: 'admin_01', name: 'System Admin', email: ADMIN_EMAIL, role: 'admin' };
  res.json({ success: true, redirect: '/records' });
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// 3. Records API (Online First)
app.get('/api/records', requireAuth, async (req, res) => {
  try {
    if (isMongoDBConnected) {
      const data = await Record.find().sort({ createdAt: -1 });
      return res.json(data);
    }
    res.status(503).json({ error: 'MongoDB database is offline' });
  } catch (err) {
    res.status(500).json({ error: 'Server record fetch error' });
  }
});

app.post('/api/records', requireAuth, async (req, res) => {
  try {
    const { date, name, phone, prev, curr } = req.body;
    const usage = Number(curr) - Number(prev);
    const total = usage * 2000;

    if (isMongoDBConnected) {
      const newRec = new Record({ date, name, phone, prev, curr, usage, total });
      await newRec.save();
      return res.status(201).json(newRec);
    }
    res.status(503).json({ error: 'Database offline. Saving blocked.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create record' });
  }
});

app.delete('/api/records/:id', requireAuth, async (req, res) => {
  try {
    if (isMongoDBConnected) {
      await Record.findByIdAndDelete(req.params.id);
      return res.json({ success: true });
    }
    res.status(503).json({ error: 'Database offline' });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// --- HTML PAGE RENDERING ROUTES ---

// Mtu akifungua link tu, itampeleka login.html moja kwa moja
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/records', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'records.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// 404 Error Handler kwa page zisizopo
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint or Page not found' });
});

app.listen(PORT, () => console.log(`🚀 Server running online on port ${PORT}`));

module.exports = app;
