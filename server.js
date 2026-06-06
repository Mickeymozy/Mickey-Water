require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const compression = require('compression');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';

// ================== LOGGING ==================
const log = {
  info: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  warn: (msg) => console.warn(`⚠️ ${msg}`),
  debug: (msg) => console.log(`🔍 ${msg}`)
};

log.info('Initializing Water Billing System with Admin Bypass...');

// ================== MIDDLEWARE ==================
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

// Request logging
app.use((req, res, next) => {
  log.debug(`${req.method} ${req.path}`);
  next();
});

// ================== SESSION SETUP ==================
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax'
  },
  name: 'adminSessionId'
}));

// ================== ADMIN ACCOUNT ==================
const ADMIN_CONFIG = {
  email: 'admin@waterbilling.com',
  password: 'admin123',
  name: 'System Administrator',
  id: 'admin_001'
};

// Simple in-memory storage (no MongoDB needed)
let billingRecords = [];
let nextRecordId = 1;

// Sample initial records
const initialRecords = [
  { id: 1, date: '2024-01-15', name: 'John Doe', phone: '0712345678', prev: 120, curr: 145, usage: 25, total: 25000, createdAt: new Date('2024-01-15') },
  { id: 2, date: '2024-01-20', name: 'Jane Smith', phone: '0723456789', prev: 80, curr: 110, usage: 30, total: 30000, createdAt: new Date('2024-01-20') },
  { id: 3, date: '2024-02-10', name: 'Mike Johnson', phone: '0734567890', prev: 200, curr: 240, usage: 40, total: 40000, createdAt: new Date('2024-02-10') }
];

billingRecords.push(...initialRecords);
nextRecordId = 4;

// ================== AUTH MIDDLEWARE ==================
const requireAdmin = (req, res, next) => {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }
  next();
};

// ================== ADMIN LOGIN (BYPASS) ==================
app.post('/api/admin-login', (req, res) => {
  try {
    // Auto-login - always successful for admin bypass
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

// Alternative simple login endpoint (for compatibility)
app.post('/api/login', (req, res) => {
  // Auto-login for admin bypass
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

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      log.error('Logout error: ' + err.message);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Check current session
app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ 
    authenticated: true, 
    user: req.session.adminUser 
  });
});

// ================== BILLING RECORDS API ==================
// Get all records
app.get('/api/records', requireAdmin, (req, res) => {
  try {
    const records = billingRecords.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, records });
  } catch (err) {
    log.error('Fetch records error: ' + err.message);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

// Get all records (admin view)
app.get('/api/records/all', requireAdmin, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const start = (page - 1) * limit;
    const end = start + limit;
    
    const records = billingRecords.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const paginatedRecords = records.slice(start, end);
    const total = records.length;
    
    res.json({ 
      success: true, 
      records: paginatedRecords,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching records' });
  }
});

// Get single record
app.get('/api/records/:id', requireAdmin, (req, res) => {
  try {
    const record = billingRecords.find(r => r.id === parseInt(req.params.id));
    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }
    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch record' });
  }
});

// Create new record
app.post('/api/records', requireAdmin, (req, res) => {
  try {
    const { name, phone, prev, curr, date } = req.body;
    
    if (!name || !phone || prev === undefined || curr === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const usage = curr - prev;
    const total = usage * 1000; // TZS 1000 per unit
    
    const newRecord = {
      id: nextRecordId++,
      date: date || new Date().toISOString().split('T')[0],
      name,
      phone,
      prev: Number(prev),
      curr: Number(curr),
      usage,
      total,
      createdAt: new Date()
    };
    
    billingRecords.push(newRecord);
    log.info(`Record created: ${name} - ${usage} units`);
    res.status(201).json({ success: true, record: newRecord });
  } catch (err) {
    log.error('Create record error: ' + err.message);
    res.status(500).json({ error: 'Failed to create record: ' + err.message });
  }
});

// Update record
app.put('/api/records/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const index = billingRecords.findIndex(r => r.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Record not found' });
    }
    
    const { name, phone, prev, curr, date } = req.body;
    const usage = curr - prev;
    const total = usage * 1000;
    
    billingRecords[index] = {
      ...billingRecords[index],
      name: name || billingRecords[index].name,
      phone: phone || billingRecords[index].phone,
      prev: prev !== undefined ? Number(prev) : billingRecords[index].prev,
      curr: curr !== undefined ? Number(curr) : billingRecords[index].curr,
      usage,
      total,
      date: date || billingRecords[index].date,
      updatedAt: new Date()
    };
    
    log.info(`Record updated: ID ${id}`);
    res.json({ success: true, record: billingRecords[index] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update record' });
  }
});

// Delete record
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

// ================== STATISTICS ==================
app.get('/api/records/count', requireAdmin, (req, res) => {
  res.json({ count: billingRecords.length });
});

app.get('/api/users/count', requireAdmin, (req, res) => {
  // For admin bypass, just return 1 (admin user)
  res.json({ count: 1 });
});

app.get('/api/payments/stats', requireAdmin, (req, res) => {
  const totalPayments = billingRecords.length;
  const totalAmount = billingRecords.reduce((sum, r) => sum + (r.total || 0), 0);
  res.json({ totalPayments, totalAmount });
});

// ================== HEALTH CHECK ==================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: ENV,
    adminBypass: true,
    recordsCount: billingRecords.length
  });
});

// ================== SERVE HTML PAGES ==================
// Serve static files
app.use(express.static(__dirname, { 
  maxAge: '1h',
  index: false
}));

// HTML Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/records', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'records.html'));
});

app.get('/main', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'main.html'));
});

// ================== 404 HANDLER ==================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// ================== ERROR HANDLER ==================
app.use((err, req, res, next) => {
  log.error('Server error: ' + err.message);
  res.status(500).json({ 
    error: 'Internal server error',
    message: ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ================== START SERVER ==================
const server = app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   🌊 WATER BILLING SYSTEM - ACTIVE 🌊    ║');
  console.log('║        ADMIN BYPASS MODE ENABLED         ║');
  console.log('╚════════════════════════════════════════════╝\n');
  console.log('📊 Server Configuration:');
  console.log(`   • Port: ${PORT}`);
  console.log(`   • Environment: ${ENV}`);
  console.log(`   • Admin Bypass: ✅ Enabled`);
  console.log(`   • Records in DB: ${billingRecords.length}`);
  console.log('\n✅ Server ready!');
  console.log(`🌐 Visit: http://localhost:${PORT}\n`);
  console.log('🔐 Admin Login: Click "Admin Login" button on login page');
  console.log('   No credentials needed!\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down...');
  server.close(() => {
    log.info('Server closed');
    process.exit(0);
  });
});

module.exports = app;