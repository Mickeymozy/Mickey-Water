require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const compression = require('compression');
const crypto = require('crypto');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';

const log = {
  info: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  warn: (msg) => console.warn(`⚠️ ${msg}`),
  debug: (msg) => console.log(`🔍 ${msg}`)
};

log.info('Initializing Water Billing System with MongoDB and Fallback Engine...');

app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS and Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: false, // Weka true ikiwa unatumia HTTPS uzalishaji (production)
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  },
  name: 'adminSessionId'
}));

// Configuration ya Admin wa Mfumo
const ADMIN_CONFIG = {
  email: 'admin@waterbilling.com',
  password: 'admin123',
  name: 'System Administrator',
  id: 'admin_001'
};

// --- DATABASE STATE & CONFIGURATION ---
let isMongoDBConnected = false;
let fallbackBillingRecords = []; // Hifadhi ya dharura kama MongoDB ikizima
let nextFallbackId = 1;

// MongoDB Schema Blueprint
const RecordSchema = new mongoose.Schema({
  id: Number,
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

// Unganisha MongoDB kwa nguvu zote
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/water_billing';

async function connectToMongoDB() {
  try {
    mongoose.set('strictQuery', false);
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000 // Subiri sekunde 5 tu, isipopatikana iwashe mfumo wa dharura
    });
    isMongoDBConnected = true;
    log.info('Successfully connected to MongoDB Database Database.');
  } catch (err) {
    isMongoDBConnected = false;
    log.warn(`MongoDB Connection Failed: ${err.message}`);
    log.warn('⚡ EMERGENCY MODE ACTIVATED: Running on Temporary Local Memory Store.');
  }
}

connectToMongoDB();

// Kupima kama MongoDB iko hai wakati wowote
mongoose.connection.on('disconnected', () => {
  isMongoDBConnected = false;
  log.error('MongoDB disconnected! Server automatically routing traffic to Local Storage.');
});

mongoose.connection.on('connected', () => {
  isMongoDBConnected = true;
  log.info('MongoDB reconnected! System restoring standard online operations.');
});


// Middleware ya Ulinzi
const requireAdmin = (req, res, next) => {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }
  next();
};

// --- AUTHENTICATION API ---
app.post('/api/admin-login', (req, res) => {
  try {
    req.session.isAdmin = true;
    req.session.adminUser = {
      id: ADMIN_CONFIG.id,
      name: ADMIN_CONFIG.name,
      email: ADMIN_CONFIG.email
    };

    log.info('Admin logged in successfully');
    res.json({ 
      success: true, 
      message: 'Admin login successful',
      user: { name: ADMIN_CONFIG.name, email: ADMIN_CONFIG.email, role: 'admin' }
    });
  } catch (err) {
    log.error('Admin login error: ' + err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      log.error('Logout error: ' + err.message);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user: req.session.adminUser });
});


// --- RECORDS OPERATIONS API (ONLINE / EMERGENCY SAFE) ---

// 1. GET ALL RECORDS
app.get('/api/records', requireAdmin, async (req, res) => {
  try {
    if (isMongoDBConnected) {
      const records = await Record.find().sort({ createdAt: -1 });
      return res.json(records);
    } else {
      // Emergency response kutoka kwenye kumbukumbu ya server
      const sortedFallback = [...fallbackBillingRecords].sort((a, b) => b.createdAt - a.createdAt);
      return res.json(sortedFallback);
    }
  } catch (err) {
    log.error('Fetch records error: ' + err.message);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

// 2. CREATE NEW BILLING RECORD
app.post('/api/records', requireAdmin, async (req, res) => {
  try {
    const { date, name, phone, prev, curr, usage, total } = req.body;

    if (!name || prev === undefined || curr === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const calculatedUsage = usage !== undefined ? Number(usage) : Number(curr) - Number(prev);
    const calculatedTotal = total !== undefined ? Number(total) : calculatedUsage * 2000;
    const finalDate = date || new Date().toLocaleDateString('en-GB');

    const recordData = {
      id: isMongoDBConnected ? Math.floor(100000 + Math.random() * 900000) : nextFallbackId++,
      date: finalDate,
      name,
      phone: phone || '-',
      prev: Number(prev),
      curr: Number(curr),
      usage: calculatedUsage,
      total: calculatedTotal,
      createdAt: new Date()
    };

    if (isMongoDBConnected) {
      const newRecord = new Record(recordData);
      await newRecord.save();
      log.info(`[MongoDB] Record created for: ${name}`);
      return res.status(201).json(newRecord);
    } else {
      fallbackBillingRecords.push(recordData);
      log.warn(`[Fallback Local] Emergency record saved for: ${name}`);
      return res.status(201).json(recordData);
    }

  } catch (err) {
    log.error('Create record error: ' + err.message);
    res.status(500).json({ error: 'Failed to create record: ' + err.message });
  }
});


// --- ADMIN PANEL MANAGEMENT ENDPOINTS ---

// 1. GET SYSTEM SUMMARY / STATS
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    let count = 0;
    if (isMongoDBConnected) {
      count = await Record.countDocuments();
    } else {
      count = fallbackBillingRecords.length;
    }

    res.json({
      totalUsers: 1, // Mfumo unatumia Admin 1 kwa sasa
      totalRecords: count,
      pendingResets: 0,
      databaseStatus: isMongoDBConnected ? 'online' : 'offline'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to aggregate system stats' });
  }
});

// 2. BROADCAST NOTIFICATIONS
app.post('/api/admin/notify', requireAdmin, (req, res) => {
  try {
    const { title, body, url } = req.body;
    log.info(`📢 BROADCAST: [${title}] - ${body} (Link: ${url || 'None'})`);
    res.json({ success: true, message: 'Notification broadcast processed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process announcement broadcast' });
  }
});


// --- SYSTEM HEALTH AND MONITORING ---
app.get('/api/health', async (req, res) => {
  let recordCount = fallbackBillingRecords.length;
  if (isMongoDBConnected) {
    try { recordCount = await Record.countDocuments(); } catch(e){}
  }
  
  res.json({ 
    status: 'ok',
    database: isMongoDBConnected ? 'MongoDB (Connected)' : 'Local Memory Storage (Emergency Mode)',
    uptime: process.uptime(),
    recordsCount: recordCount,
    port: PORT
  });
});

// Serve static elements
app.use(express.static(__dirname, { maxAge: '1h', index: false }));

// HTML Engine Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/records', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'records.html')));
app.get('/main', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'records.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// 404 Routing Error Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method });
});

// Global Error Handler
app.use((err, req, res, next) => {
  log.error('Server error: ' + err.message);
  res.status(500).json({ 
    error: 'Internal server error',
    message: ENV === 'development' ? err.message : 'Something went wrong inside the core service.'
  });
});

// Booting Up process
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   🌊 WATER BILLING SYSTEM - ACTIVE 🌊    ║');
  console.log('╚════════════════════════════════════════════╝\n');
  console.log(`   • Operational Port : ${PORT}`);
  console.log(`   • Environment      : ${ENV.toUpperCase()}`);
  console.log(`   • Live Connection  : http://localhost:${PORT}\n`);
  console.log('⚙️  Server monitoring database engines closely...\n');
});

module.exports = app;
