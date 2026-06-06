require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const compression = require('compression');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000; // Badilisha port to 3000
const ENV = process.env.NODE_ENV || 'development';

const log = {
  info: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  warn: (msg) => console.warn(`⚠️ ${msg}`),
  debug: (msg) => console.log(`🔍 ${msg}`)
};

log.info('Initializing Water Billing System...');

app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS and Headers
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

app.use((req, res, next) => {
  log.debug(`${req.method} ${req.path}`);
  next();
});

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  },
  name: 'adminSessionId'
}));

// Admin account
const ADMIN_CONFIG = {
  email: 'admin@waterbilling.com',
  password: 'admin123',
  name: 'System Administrator',
  id: 'admin_001'
};

// In-memory storage
let billingRecords = [];
let nextRecordId = 1;

// Sample initial records
const initialRecords = [
  { 
    id: 1, 
    date: '15/01/2024', 
    name: 'John Doe', 
    phone: '0712345678', 
    prev: 120, 
    curr: 145, 
    usage: 25, 
    total: 50000, 
    createdAt: new Date('2024-01-15') 
  },
  { 
    id: 2, 
    date: '20/01/2024', 
    name: 'Jane Smith', 
    phone: '0723456789', 
    prev: 80, 
    curr: 110, 
    usage: 30, 
    total: 60000, 
    createdAt: new Date('2024-01-20') 
  }
];

billingRecords.push(...initialRecords);
nextRecordId = 3;

const requireAdmin = (req, res, next) => {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }
  next();
};

// Admin login
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
      user: {
        name: ADMIN_CONFIG.name,
        email: ADMIN_CONFIG.email,
        role: 'admin'
      }
    });
  } catch (err) {
    log.error('Admin login error: ' + err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/login', (req, res) => {
  req.session.isAdmin = true;
  req.session.adminUser = {
    id: ADMIN_CONFIG.id,
    name: ADMIN_CONFIG.name,
    email: ADMIN_CONFIG.email
  };
  
  res.json({ 
    success: true, 
    message: 'Login successful',
    user: {
      name: ADMIN_CONFIG.name,
      email: ADMIN_CONFIG.email,
      role: 'admin'
    }
  });
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
  res.json({ 
    authenticated: true, 
    user: req.session.adminUser 
  });
});

// Records API
app.get('/api/records', requireAdmin, (req, res) => {
  try {
    const records = billingRecords.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(records);
  } catch (err) {
    log.error('Fetch records error: ' + err.message);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

app.post('/api/records', requireAdmin, (req, res) => {
  try {
    const { date, name, phone, prev, curr, usage, total } = req.body;
    
    if (!name || prev === undefined || curr === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const newRecord = {
      id: nextRecordId++,
      date: date || new Date().toLocaleDateString('en-GB'),
      name,
      phone: phone || '-',
      prev: Number(prev),
      curr: Number(curr),
      usage: usage !== undefined ? Number(usage) : Number(curr) - Number(prev),
      total: total !== undefined ? Number(total) : (Number(curr) - Number(prev)) * 2000,
      createdAt: new Date()
    };
    
    billingRecords.push(newRecord);
    log.info(`Record created: ${name} - ${newRecord.usage} units`);
    res.status(201).json(newRecord);
  } catch (err) {
    log.error('Create record error: ' + err.message);
    res.status(500).json({ error: 'Failed to create record: ' + err.message });
  }
});

app.delete('/api/records/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const index = billingRecords.findIndex(r => r.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Record not found' });
    }
    
    billingRecords.splice(index, 1);
    log.info(`Record deleted: ID ${id}`);
    res.json({ success: true, message: 'Record deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    recordsCount: billingRecords.length,
    port: PORT
  });
});

// Serve static files
app.use(express.static(__dirname, { maxAge: '1h', index: false }));

// HTML Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/records', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'records.html'));
});

app.get('/main', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'records.html'));
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  log.error('Server error: ' + err.message);
  res.status(500).json({ 
    error: 'Internal server error',
    message: ENV === 'development' ? err.message : 'Something went wrong'
  });
});

const server = app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   🌊 WATER BILLING SYSTEM - ACTIVE 🌊    ║');
  console.log('╚════════════════════════════════════════════╝\n');
  console.log(`   • Port: ${PORT}`);
  console.log(`   • Records: ${billingRecords.length}`);
  console.log(`   • URL: http://localhost:${PORT}\n`);
  console.log('🔐 Click "Admin Login" button to access the system\n');
});

module.exports = app;