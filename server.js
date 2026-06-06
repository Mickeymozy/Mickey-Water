require('dotenv').config();
const express = require('express');
const path = require('path');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const compression = require('compression');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

// ================== CONSTANTS & CONFIG ==================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/water_billing';
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';

// ================== APP STATE ==================
let mongoConnected = false;
let sessionStoreType = 'memory';

// ================== STARTUP LOG ==================
const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`)
};

log.info('Initializing Water Billing Server...');

// ================== SERVE STATIC FILES WITH FALLBACK ==================
const serveStaticFile = (filename) => (req, res, next) => {
  const filePath = path.join(__dirname, filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath, (err) => {
      if (err) next(err);
    });
  } else {
    log.warn(`File not found: ${filename} - Creating fallback response`);
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Water Billing System</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
          h1 { color: #2c3e50; }
          .container { max-width: 800px; margin: 0 auto; }
          .status { background: #e8f4f8; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .error { color: #e74c3c; }
          .success { color: #27ae60; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🌊 Water Billing System</h1>
          <div class="status">
            <p class="success">✅ Server is running normally</p>
            <p>Static files are missing. Please ensure these files exist:</p>
            <ul>
              <li>index.html</li>
              <li>login.html</li>
              <li>signup.html</li>
              <li>admin.html</li>
              <li>records.html</li>
              <li>main.html</li>
            </ul>
            <hr>
            <p><strong>API is working!</strong> Try <a href="/api/health">/api/health</a></p>
          </div>
        </div>
      </body>
      </html>
    `);
  }
};

// ================== PROXY TRUST ==================
app.set('trust proxy', 1);
log.success('Proxy trust configured');

// ================== EMAIL CONFIGURATION ==================
let emailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    tls: { rejectUnauthorized: false }
  });
  log.success('Email service configured');
} else {
  log.warn('Email configuration incomplete - notifications disabled');
}

const sendEmail = async (to, subject, html) => {
  try {
    if (!emailTransporter) {
      log.warn('Email service not available');
      return { success: false, error: 'Email service not configured' };
    }
    const info = await emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || '"Water Billing System" <noreply@waterbilling.local>',
      to: to,
      subject: subject,
      html: html
    });
    log.success(`Email sent to: ${to}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    log.error('Email send failed: ' + err.message);
    return { success: false, error: err.message };
  }
};

// ================== MIDDLEWARE: SECURITY HEADERS ==================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // CORS headers for development
  if (ENV === 'development') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  next();
});

// ================== MIDDLEWARE: REQUEST LOGGING ==================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusColor = res.statusCode < 400 ? '✅' : res.statusCode < 500 ? '⚠️' : '❌';
    log.info(`${statusColor} ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// ================== MIDDLEWARE: COMPRESSION ==================
app.use(compression({ threshold: 1024, level: 6 }));

// ================== MIDDLEWARE: BODY PARSER ==================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ================== MIDDLEWARE: STATIC FILES ==================
app.use(express.static(__dirname, { 
  maxAge: '24h',
  etag: true,
  index: false
}));

// ================== DATABASE CONNECTION ==================
const connectDB = async () => {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });
      mongoConnected = true;
      log.success('MongoDB connected successfully');
    }
  } catch (err) {
    mongoConnected = false;
    log.error('MongoDB connection failed: ' + err.message);
    throw err;
  }
};

// Connect to database immediately
connectDB().catch(err => log.error('Initial DB connection failed: ' + err.message));

mongoose.set('strictQuery', true);

// ================== MIDDLEWARE: SESSION STORE ==================
let sessionStore = null;

const initializeSessionStore = async () => {
  try {
    if (mongoConnected) {
      sessionStore = MongoStore.create({
        client: mongoose.connection.getClient(),
        collectionName: 'sessions',
        ttl: 7 * 24 * 60 * 60,
        autoRemove: 'interval',
        autoRemoveInterval: 10,
        touchAfter: 24 * 3600
      });
      sessionStoreType = 'mongodb';
      log.success('Session store: MongoDB');
    } else {
      throw new Error('MongoDB not connected');
    }
  } catch (err) {
    log.warn('MongoDB session store unavailable: ' + err.message);
    const MemoryStore = require('express-session').MemoryStore;
    sessionStore = new MemoryStore();
    sessionStoreType = 'memory';
    log.warn('Session store: Memory (data will be lost on restart)');
  }
};

// ================== MIDDLEWARE: SESSION ==================
app.use(async (req, res, next) => {
  if (!sessionStore) {
    await initializeSessionStore();
  }
  next();
});

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: ENV === 'production' ? true : false,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  },
  name: 'waterBillingSid'
});

app.use(sessionMiddleware);
log.success('Session middleware enabled');

// ================== MIDDLEWARE: PASSPORT ==================
app.use(passport.initialize());
app.use(passport.session());
log.success('Passport authentication configured');

// ================== MODELS WITH INDEXES ==================
let User, Record, PasswordResetRequest, StreamAnalytics;

try {
  const userSchema = new mongoose.Schema({
    id: { type: String, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    passwordHash: String,
    provider: { type: String, default: 'local' },
    googleId: { type: String, sparse: true, index: true },
    picture: String,
    resetToken: { type: String, sparse: true, index: true },
    resetExpiry: { type: Date, sparse: true, index: true },
    lastLogin: { type: Date, default: null },
    tempPassword: String,
    passwordChangeRequired: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: true }
  });

  const recordSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    date: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true, index: true },
    prev: { type: Number, required: true },
    curr: { type: Number, required: true },
    usage: { type: Number, required: true },
    total: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now, index: true }
  });

  const passwordResetSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true, index: true },
    userName: String,
    resetToken: { type: String, unique: true, sparse: true },
    newPassword: String,
    createdAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, index: true },
    status: { type: String, enum: ['pending', 'approved', 'completed', 'expired'], default: 'pending' },
    emailSent: { type: Boolean, default: false },
    approvedBy: String,
    approvedAt: Date
  });

  const streamAnalyticsSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    userId: String,
    userEmail: String,
    timestamp: { type: Date, default: Date.now, index: true },
    event: { type: String, required: true, index: true },
    channel: String,
    category: String,
    severity: { type: String, enum: ['info', 'warning', 'error', 'critical'], default: 'info' },
    data: mongoose.Schema.Types.Mixed,
    userAgent: String,
    createdAt: { type: Date, default: Date.now, index: true, expires: 2592000 }
  });

  User = mongoose.models.User || mongoose.model('User', userSchema);
  Record = mongoose.models.Record || mongoose.model('Record', recordSchema);
  PasswordResetRequest = mongoose.models.PasswordResetRequest || mongoose.model('PasswordResetRequest', passwordResetSchema);
  StreamAnalytics = mongoose.models.StreamAnalytics || mongoose.model('StreamAnalytics', streamAnalyticsSchema);

  log.success('Database models initialized');
} catch (err) {
  log.error('Model initialization failed: ' + err.message);
  throw err;
}

// ================== PASSPORT STRATEGIES ==================
passport.use('local', new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    if (!User) return done(new Error('User model not loaded'));
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return done(null, false, { message: 'User not found' });
    }

    if (!user.passwordHash) {
      return done(null, false, { message: 'Invalid login method. Use Google Sign-in instead.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return done(null, false, { message: 'Invalid email or password' });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    return done(null, user);
  } catch (err) {
    log.error('Local strategy error: ' + err.message);
    return done(err);
  }
}));

// Google Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use('google', new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`,
    proxy: true
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      if (!User) return done(new Error('User model not loaded'));
      if (!profile.id) return done(new Error('Invalid Google profile'));

      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('Email required from Google profile'));

      let user = await User.findOne({ $or: [{ googleId: profile.id }, { email: email.toLowerCase() }] });

      if (!user) {
        // Create new user
        user = new User({
          id: profile.id,
          googleId: profile.id,
          name: profile.displayName || email.split('@')[0],
          email: email.toLowerCase(),
          picture: profile.photos?.[0]?.value,
          provider: 'google',
          lastLogin: new Date()
        });
        await user.save();
        log.success(`New Google user created: ${email}`);
      } else {
        // Update existing user
        if (!user.googleId) {
          user.googleId = profile.id;
        }
        user.picture = profile.photos?.[0]?.value || user.picture;
        user.lastLogin = new Date();
        user.name = profile.displayName || user.name;
        await user.save();
        log.success(`Google user updated: ${email}`);
      }

      return done(null, user);
    } catch (err) {
      log.error('Google strategy error: ' + err.message);
      return done(err);
    }
  }));
  log.success('Google OAuth configured');
} else {
  log.warn('Google OAuth not configured - missing credentials');
}

passport.serializeUser((user, done) => {
  done(null, user._id.toString());
});

passport.deserializeUser(async (id, done) => {
  try {
    if (!id || !User) return done(null, false);
    const user = await User.findById(id).lean();
    if (!user) return done(null, false);
    done(null, user);
  } catch (err) {
    log.error('Deserialize error: ' + err.message);
    done(err, false);
  }
});

// ================== AUTH MIDDLEWARE ==================
const protect = (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: "Please log in to continue" });
  }
  next();
};

const adminEmails = (process.env.ADMIN_EMAILS || 'mickidadyhamza@gmail.com').split(',');
const isAdmin = (user) => user && adminEmails.includes(user.email);

// ================== SERVE HTML PAGES ==================
app.get('/', serveStaticFile('index.html'));
app.get('/login', serveStaticFile('login.html'));
app.get('/signup', serveStaticFile('signup.html'));
app.get('/admin', protect, (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).send('Access denied. Admin only.');
  }
  serveStaticFile('admin.html')(req, res);
});
app.get('/records', protect, serveStaticFile('records.html'));
app.get('/main', protect, serveStaticFile('main.html'));

// ================== API ENDPOINTS ==================
app.get('/api/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: dbStatus,
    sessionStore: sessionStoreType,
    environment: ENV,
    googleConfigured: !!process.env.GOOGLE_CLIENT_ID
  });
});

app.get('/api/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user: req.user });
});

// ================== RECORDS ENDPOINTS ==================
app.get('/api/records', protect, async (req, res) => {
  try {
    let query = {};
    if (!isAdmin(req.user)) {
      query = { phone: req.user.email };
    }
    const records = await Record.find(query).sort({ createdAt: -1 });
    res.json({ success: true, records });
  } catch (err) {
    log.error('Fetch records error: ' + err.message);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

app.post('/api/records', protect, async (req, res) => {
  try {
    const { name, phone, prev, curr, usage, total, date } = req.body;
    
    if (!name || !phone || prev === undefined || curr === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const newRecord = new Record({
      userId: req.user._id.toString(),
      date: date || new Date().toISOString().split('T')[0],
      name,
      phone: phone.toLowerCase(),
      prev: Number(prev),
      curr: Number(curr),
      usage: usage !== undefined ? Number(usage) : Number(curr) - Number(prev),
      total: total !== undefined ? Number(total) : (Number(curr) - Number(prev)) * 1000
    });
    
    await newRecord.save();
    res.status(201).json({ success: true, data: newRecord });
  } catch (err) {
    log.error('Save record error: ' + err.message);
    res.status(500).json({ error: 'Failed to save record: ' + err.message });
  }
});

// ================== USER MANAGEMENT ==================
app.get('/api/users/list', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const users = await User.find({}).select('-passwordHash -resetToken').lean().sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (err) {
    log.error('Fetch users error: ' + err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/users/count', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const count = await User.countDocuments({});
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to count users' });
  }
});

app.put('/api/users/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { name, email } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email.toLowerCase();
    
    const user = await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).select('-passwordHash');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/users/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await Record.deleteMany({ userId: user.id || user._id.toString() });
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.get('/api/records/count', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const count = await Record.countDocuments({});
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to count records' });
  }
});

app.get('/api/records/all', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      Record.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Record.countDocuments({})
    ]);
    res.json({ success: true, records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching records' });
  }
});

app.put('/api/records/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { name, phone, prev, curr, usage, total } = req.body;
    const updateData = { name, phone, prev, curr, usage, total };
    if (typeof prev === 'number' && typeof curr === 'number') {
      updateData.usage = curr - prev;
    }

    const record = await Record.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ error: 'Error updating record' });
  }
});

app.delete('/api/records/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    await Record.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Error deleting record' });
  }
});

app.get('/api/payments/stats', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const records = await Record.find({}).lean();
    const totalPayments = records.length;
    const totalAmount = records.reduce((sum, r) => sum + (r.total || 0), 0);
    res.json({ totalPayments, totalAmount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get payment stats' });
  }
});

app.post('/api/zenopay/checkout', protect, async (req, res) => {
  try {
    const { recordId, amount, currency = 'TZS', customerName, customerEmail, customerPhone } = req.body;
    
    if (!process.env.ZENOPAY_API_KEY) {
      return res.status(500).json({ error: 'Zenopay API key missing' });
    }

    const rawBaseUrl = (process.env.ZENOPAY_API_URL || 'https://api.zenoapi.com').trim().replace(/\/+$/, '');
    const checkoutUrl = `${rawBaseUrl}${process.env.ZENOPAY_CHECKOUT_PATH || '/checkout/sessions'}`;

    const callbackUrl = `${process.env.APP_URL || `http://localhost:${PORT}`}/records.html`;
    const payload = {
      amount: Number(amount),
      currency,
      description: `Water billing payment for record ${recordId}`,
      callback_url: callbackUrl,
      metadata: { recordId, customerName, customerEmail, customerPhone },
      customer: { name: customerName, email: customerEmail, phone: customerPhone }
    };

    const response = await axios.post(checkoutUrl, payload, {
      headers: { 
        'Authorization': `Bearer ${process.env.ZENOPAY_API_KEY}`, 
        'Content-Type': 'application/json' 
      },
      timeout: 10000
    });

    const data = response.data || {};
    const redirectUrl = data.checkoutUrl || data.redirectUrl || data.url || data.data?.checkout_url;
    
    if (!redirectUrl) {
      throw new Error('No redirect URL returned');
    }
    
    res.json({ checkoutUrl: redirectUrl });
  } catch (err) {
    log.error('Zenopay error: ' + err.message);
    res.status(500).json({ error: 'Payment initialization failed: ' + err.message });
  }
});

// ================== AUTHENTICATION ENDPOINTS ==================
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered. Please login instead.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ 
      id: Date.now().toString(), 
      name, 
      email: email.toLowerCase(), 
      passwordHash: hashedPassword, 
      provider: 'local',
      lastLogin: new Date()
    });
    
    await newUser.save();

    // Login the user after signup
    req.login(newUser, (err) => {
      if (err) {
        log.error('Login after signup error: ' + err.message);
        return res.status(500).json({ error: 'Account created but login failed' });
      }
      return res.json({ success: true, user: { id: newUser._id, name: newUser.name, email: newUser.email } });
    });
  } catch (err) {
    log.error('Signup error: ' + err.message);
    res.status(500).json({ error: 'Signup failed: ' + err.message });
  }
});

app.post('/api/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) {
      log.error('Login authentication error: ' + err.message);
      return res.status(500).json({ error: 'Authentication error. Please try again.' });
    }
    
    if (!user) {
      return res.status(401).json({ error: info?.message || 'Invalid email or password' });
    }

    req.login(user, (loginErr) => {
      if (loginErr) {
        log.error('Session login error: ' + loginErr.message);
        return res.status(500).json({ error: 'Failed to create session. Please try again.' });
      }
      
      // Return user without sensitive data
      const userData = {
        id: user._id,
        name: user.name,
        email: user.email,
        provider: user.provider,
        picture: user.picture
      };
      
      return res.json({ success: true, user: userData });
    });
  })(req, res, next);
});

app.post('/api/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      log.error('Logout error: ' + err.message);
      return res.status(500).json({ error: 'Logout failed' });
    }
    req.session.destroy((sessionErr) => {
      if (sessionErr) {
        log.warn('Session destroy error: ' + sessionErr.message);
      }
      res.json({ success: true, message: 'Logged out successfully' });
    });
  });
});

// ================== GOOGLE AUTH ROUTES ==================
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google', 
    passport.authenticate('google', { 
      scope: ['profile', 'email'],
      prompt: 'select_account'
    })
  );

  app.get('/auth/google/callback', 
    passport.authenticate('google', { 
      failureRedirect: '/login?error=google_auth_failed',
      failureMessage: true
    }),
    (req, res) => {
      res.redirect('/main');
    }
  );
}

// ================== PASSWORD RESET ENDPOINTS ==================
app.post('/api/password-reset-request', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'Email not found in our system' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours

    user.resetToken = resetToken;
    user.resetExpiry = new Date(resetExpiry);
    await user.save();

    const resetRequest = new PasswordResetRequest({
      email: user.email,
      userName: user.name,
      resetToken,
      expiresAt: new Date(resetExpiry),
      status: 'pending'
    });
    await resetRequest.save();

    // Send notification email to admin
    if (adminEmails.length > 0) {
      await sendEmail(
        adminEmails[0],
        'Password Reset Request',
        `<h2>Password Reset Request</h2>
         <p>User: ${user.name}</p>
         <p>Email: ${user.email}</p>
         <p>Request ID: ${resetRequest._id}</p>
         <p>Please login to admin panel to approve this request.</p>`
      );
    }

    res.json({ success: true, message: 'Reset request submitted. Admin will review and contact you.' });
  } catch (err) {
    log.error('Password reset request error: ' + err.message);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

app.get('/api/password-reset-requests', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const requests = await PasswordResetRequest.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching requests' });
  }
});

app.post('/api/admin/approve-password-reset', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { requestId } = req.body;
    const resetRequest = await PasswordResetRequest.findById(requestId);
    
    if (!resetRequest) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    if (resetRequest.status !== 'pending') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    const newPassword = crypto.randomBytes(6).toString('hex').toUpperCase();
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const user = await User.findOne({ email: resetRequest.email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.passwordHash = hashedPassword;
    user.passwordChangeRequired = true;
    user.tempPassword = newPassword;
    user.resetToken = undefined;
    user.resetExpiry = undefined;
    await user.save();

    resetRequest.status = 'approved';
    resetRequest.newPassword = newPassword;
    resetRequest.approvedBy = req.user.email;
    resetRequest.approvedAt = new Date();
    await resetRequest.save();

    await sendEmail(
      user.email,
      'Password Reset Approved',
      `<h2>Password Reset Approved</h2>
       <p>Hello ${user.name},</p>
       <p>Your password reset request has been approved.</p>
       <p><strong>Temporary Password: ${newPassword}</strong></p>
       <p>Please login and change your password immediately.</p>
       <a href="${process.env.APP_URL || `http://localhost:${PORT}`}/login">Click here to login</a>`
    );

    res.json({ success: true, message: 'Password reset approved and email sent' });
  } catch (err) {
    log.error('Approve reset error: ' + err.message);
    res.status(500).json({ error: 'Error approving request' });
  }
});

app.post('/api/admin/reset-user-password', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { userId } = req.body;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newPassword = crypto.randomBytes(6).toString('hex').toUpperCase();
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordChangeRequired = true;
    user.tempPassword = newPassword;
    await user.save();

    await sendEmail(
      user.email,
      'Password Reset by Admin',
      `<h2>Password Reset</h2>
       <p>Hello ${user.name},</p>
       <p>An administrator has reset your password.</p>
       <p><strong>Temporary Password: ${newPassword}</strong></p>
       <p>Please login and change your password immediately.</p>
       <a href="${process.env.APP_URL || `http://localhost:${PORT}`}/login">Click here to login</a>`
    );

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Error resetting password' });
  }
});

// ================== SETUP ADMIN ==================
app.post('/api/setup-admin', async (req, res) => {
  try {
    const adminEmail = adminEmails[0];
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
    
    let adminUser = await User.findOne({ email: adminEmail });
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    if (adminUser) {
      adminUser.passwordHash = hashedPassword;
      adminUser.name = 'System Administrator';
      await adminUser.save();
    } else {
      adminUser = new User({
        id: 'admin_' + Date.now(),
        name: 'System Administrator',
        email: adminEmail,
        passwordHash: hashedPassword,
        provider: 'local'
      });
      await adminUser.save();
    }
    
    res.json({ success: true, message: 'Admin account configured', email: adminEmail });
  } catch (err) {
    log.error('Setup admin error: ' + err.message);
    res.status(500).json({ error: 'Error setting up admin' });
  }
});

// ================== 404 HANDLER ==================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'API endpoint not found', 
    path: req.path,
    method: req.method 
  });
});

// ================== GLOBAL ERROR HANDLER ==================
app.use((err, req, res, next) => {
  log.error('Unhandled error: ' + (err.message || JSON.stringify(err)));

  if (err.stack && ENV === 'development') {
    log.error('Stack: ' + err.stack.split('\n').slice(0, 3).join(' | '));
  }

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({ 
    error: 'Internal server error',
    message: ENV === 'development' ? err.message : 'Something went wrong. Please try again.'
  });
});

// ================== UNCAUGHT EXCEPTION HANDLER ==================
process.on('uncaughtException', (err) => {
  log.error('UNCAUGHT EXCEPTION: ' + err.message);
  if (err.stack) {
    log.error('Stack: ' + err.stack.split('\n').slice(0, 5).join(' | '));
  }
  // Don't exit in production, just log
  if (ENV !== 'production') {
    process.exit(1);
  }
});

// ================== UNHANDLED REJECTION HANDLER ==================
process.on('unhandledRejection', (reason, promise) => {
  log.error('UNHANDLED REJECTION: ' + (reason?.message || reason));
});

// ================== STARTUP ==================
const startupInfo = {
  environment: ENV,
  port: PORT,
  mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...',
  sessionStore: sessionStoreType,
  googleAuth: !!process.env.GOOGLE_CLIENT_ID ? 'Enabled' : 'Disabled',
  timestamp: new Date().toISOString()
};

const displayStartupInfo = () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   🌊 WATER BILLING SYSTEM - FIXED 🌊     ║');
  console.log('╚════════════════════════════════════════════╝\n');
  console.log('📊 Server Configuration:');
  console.log(`   • Environment: ${startupInfo.environment}`);
  console.log(`   • Port: ${startupInfo.port}`);
  console.log(`   • Database: ${startupInfo.mongodb}`);
  console.log(`   • Session Store: ${startupInfo.sessionStore}`);
  console.log(`   • Google Auth: ${startupInfo.googleAuth}`);
  console.log(`   • Started: ${startupInfo.timestamp}`);
  console.log('\n✅ Server is ready!');
  console.log(`🌐 Visit: http://localhost:${PORT}\n`);
};

if (require.main === module) {
  const server = app.listen(PORT, () => {
    displayStartupInfo();
  });

  const gracefulShutdown = (signal) => {
    log.warn(`${signal} received, shutting down gracefully...`);
    server.close(() => {
      log.info('HTTP server closed');
      if (mongoose.connection.readyState === 1) {
        mongoose.connection.close().then(() => {
          log.info('Database connection closed');
          process.exit(0);
        }).catch(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
    
    // Force shutdown after 10 seconds
    setTimeout(() => {
      log.error('Forced shutdown');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
} else {
  log.info('Running as serverless function');
}

module.exports = app;