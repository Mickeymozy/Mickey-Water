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

// ================== PROXY TRUST (FIX KWA AJILI YA VERCEL/RENDER) ==================
try {
  app.set('trust proxy', 1);
  log.success('Proxy trust configured');
} catch (err) {
  log.warn('Proxy trust config failed: ' + err.message);
}

// ================== EMAIL CONFIGURATION (SAFE) ==================
let emailTransporter = null;
try {
  if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    emailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });
    log.success('Email service configured');
  } else {
    log.warn('Email configuration incomplete - notifications disabled');
  }
} catch (err) {
  log.warn('Email configuration error: ' + err.message);
}

const sendEmail = async (to, subject, html) => {
  try {
    if (!emailTransporter) {
      log.warn('Email service not available');
      return { success: false, error: 'Email service not configured' };
    }

    const info = await emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || 'Water Billing System <noreply@waterbilling.local>',
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
try {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });
  log.success('Security headers enabled');
} catch (err) {
  log.warn('Security headers setup failed: ' + err.message);
}

// ================== MIDDLEWARE: REQUEST LOGGING ==================
try {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const statusColor = res.statusCode < 400 ? '✅' : res.statusCode < 500 ? '⚠️' : '❌';
      log.info(`${statusColor} ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
  });
} catch (err) {
  log.warn('Request logging setup failed: ' + err.message);
}

// ================== MIDDLEWARE: COMPRESSION ==================
try {
  app.use(compression({ threshold: 1024, level: 6 }));
  log.success('Compression enabled');
} catch (err) {
  log.warn('Compression setup failed: ' + err.message);
}

// ================== MIDDLEWARE: CACHE CONTROL ==================
try {
  app.use((req, res, next) => {
    if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('ETag', 'disabled');
    } else if (req.path.match(/\.(html)$/)) {
      res.set('Cache-Control', 'public, max-age=3600');
    } else {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
  });
} catch (err) {
  log.warn('Cache control setup failed: ' + err.message);
}

// ================== MIDDLEWARE: BODY PARSER ==================
try {
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  log.success('Body parser configured');
} catch (err) {
  log.error('Body parser setup failed: ' + err.message);
}

// ================== MIDDLEWARE: STATIC FILES ==================
try {
  app.use(express.static(__dirname, { 
    maxAge: '24h',
    etag: false,
    index: true
  }));
  log.success('Static file serving enabled');
} catch (err) {
  log.warn('Static file setup failed: ' + err.message);
}

// ================== MIDDLEWARE: DATABASE CONNECTION (LAZY) ==================
app.use(async (req, res, next) => {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000
      });
      mongoConnected = true;
      log.success('MongoDB connected');
    }
    next();
  } catch (err) {
    mongoConnected = false;
    log.warn('MongoDB connection failed: ' + err.message);
    // Don't block - continue anyway
    next();
  }
});

try {
  mongoose.set('strictQuery', true);
} catch (err) {
  log.warn('Mongoose config failed: ' + err.message);
}

// ================== MIDDLEWARE: SESSION STORE (SAFE INITIALIZATION) ==================
let sessionStore = null;
let sessionStoreError = null;

try {
  // Try MongoDB store
  sessionStore = MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'sessions',
    ttl: 7 * 24 * 60 * 60,
    autoRemove: 'interval',
    autoRemoveInterval: 10
  });
  sessionStoreType = 'mongodb';
  log.success('Session store: MongoDB');
} catch (err) {
  sessionStoreError = err.message;
  log.warn('MongoDB session store unavailable: ' + err.message);
  // Fallback to memory store
  try {
    const session_pkg = require('express-session');
    sessionStore = new session_pkg.MemoryStore();
    sessionStoreType = 'memory';
    log.warn('Session store: Memory (data will be lost on restart)');
  } catch (fallbackErr) {
    log.error('Session store initialization failed: ' + fallbackErr.message);
  }
}

// ================== MIDDLEWARE: SESSION ==================
if (sessionStore) {
  try {
    app.use(session({
      secret: process.env.SESSION_SECRET || 'default-secret-change-me',
      resave: false, 
      saveUninitialized: false, 
      store: sessionStore,
      cookie: { 
        secure: true,
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
      },
      name: 'waterBillingSid'
    }));
    log.success('Session middleware enabled');
  } catch (err) {
    log.error('Session middleware failed: ' + err.message);
  }
}

// ================== MIDDLEWARE: PASSPORT ==================
try {
  app.use(passport.initialize());
  app.use(passport.session());
  log.success('Passport authentication configured');
} catch (err) {
  log.error('Passport setup failed: ' + err.message);
}

// ================== MODELS WITH INDEXES ==================
let User, Record, PasswordResetRequest, StreamAnalytics;

try {
  const userSchema = new mongoose.Schema({
    id: { type: String, index: true },
    name: String,
    email: { type: String, index: true, unique: true, sparse: true },
    passwordHash: String,
    provider: String,
    googleId: String,
    picture: String,
    resetToken: { type: String, index: true, sparse: true },
    resetExpiry: { type: Date, index: true, sparse: true },
    lastLogin: { type: Date, default: null },
    tempPassword: { type: String, sparse: true },
    passwordChangeRequired: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: true }
  });

  const recordSchema = new mongoose.Schema({
    userId: { type: String, index: true }, 
    date: String, 
    name: String,
    phone: { type: String, index: true }, 
    prev: Number,
    curr: Number,
    usage: Number,
    total: Number,
    createdAt: { type: Date, default: Date.now, index: true }
  });

  recordSchema.index({ userId: 1, createdAt: -1 });
  recordSchema.index({ phone: 1, createdAt: -1 });

  const passwordResetSchema = new mongoose.Schema({
    email: { type: String, required: true, index: true },
    userName: String,
    resetToken: { type: String, unique: true, sparse: true },
    newPassword: { type: String, sparse: true },
    createdAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, index: true },
    status: { type: String, enum: ['pending', 'approved', 'completed', 'expired'], default: 'pending' },
    emailSent: { type: Boolean, default: false },
    approvedBy: String,
    approvedAt: Date
  });

  const streamAnalyticsSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    userId: { type: String, sparse: true, index: true },
    userEmail: { type: String, sparse: true, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
    event: { type: String, required: true, index: true },
    channel: { type: String, index: true },
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
}

// ================== PASSPORT STRATEGIES ==================
try {
  passport.use('local', new LocalStrategy({
    usernameField: 'email',
    passwordField: 'password'
  }, async (email, password, done) => {
    try {
      if (!User) return done(new Error('User model not loaded'));
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) return done(null, false, { message: 'User not found' });

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) return done(null, false, { message: 'Invalid password' });

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
  log.success('Local authentication strategy configured');
} catch (err) {
  log.warn('Local strategy setup failed: ' + err.message);
}

try {
  passport.use('google', new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'not-configured',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'not-configured',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'https://mickey-glitch.onrender.com/auth/google/callback',
    proxy: true 
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      if (!User) return done(new Error('User model not loaded'));
      if (!profile.id) return done(new Error('Invalid Google profile'));

      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('Email required from Google profile'));

      let user = await User.findOne({ googleId: profile.id });

      if (!user) {
        const existingByEmail = await User.findOne({ email: email.toLowerCase() });
        if (existingByEmail) {
          existingByEmail.googleId = profile.id;
          existingByEmail.picture = profile.photos?.[0]?.value || existingByEmail.picture;
          existingByEmail.lastLogin = new Date();
          await existingByEmail.save();
          return done(null, existingByEmail);
        }

        user = new User({
          id: profile.id,
          googleId: profile.id,
          name: profile.displayName || 'User',
          email: email.toLowerCase(),
          picture: profile.photos?.[0]?.value,
          provider: 'google',
          lastLogin: new Date()
        });
        await user.save();
      } else {
        user.lastLogin = new Date();
        user.picture = profile.photos?.[0]?.value || user.picture;
        await user.save();
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
  log.success('Google authentication strategy configured');
} catch (err) {
  log.warn('Google strategy setup failed: ' + err.message);
}

try {
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
      done(err);
    }
  });
  log.success('Passport serialization configured');
} catch (err) {
  log.warn('Passport serialization setup failed: ' + err.message);
}

// ================== AUTH MIDDLEWARE ==================
const protect = (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const adminEmails = ['mickidadyhamza@gmail.com'];
const isAdmin = (user) => user && adminEmails.includes(user.email);

// ================== SERVE HTML PAGES ==================
app.get('/', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.get('/login', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'login.html'), (err) => {
    if (err) next(err);
  });
});

app.get('/signup', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'signup.html'), (err) => {
    if (err) next(err);
  });
});

app.get('/admin', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'admin.html'), (err) => {
    if (err) next(err);
  });
});

app.get('/records', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'records.html'), (err) => {
    if (err) next(err);
  });
});

app.get('/main', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'main.html'), (err) => {
    if (err) next(err);
  });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({});
  res.json({ user: req.user });
});

// ================== RECORDS ENDPOINTS ==================
app.get('/api/records', protect, async (req, res) => {
  try {
    let query = {};
    if (!isAdmin(req.user)) {
      query = { phone: req.user.email.toLowerCase() };
    }
    const records = await Record.find(query).sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

app.post('/api/records', protect, async (req, res) => {
  try {
    const { name, phone, prev, curr, usage, total, date } = req.body;
    const newRecord = new Record({
      userId: req.user._id.toString(), 
      date,
      name,
      phone: phone ? phone.toLowerCase() : '', 
      prev,
      curr,
      usage,
      total
    });
    await newRecord.save();
    res.status(201).json({ success: true, data: newRecord });
  } catch (err) {
    res.status(400).json({ error: 'Failed to save record' });
  }
});

// ================== USER MANAGEMENT ENDPOINTS ==================
app.get('/api/users/list', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const users = await User.find({}).select('-passwordHash').lean().sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/users/count', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const count = await User.countDocuments({});
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to count users' });
  }
});

app.put('/api/users/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const { name, email } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email.toLowerCase();
    const user = await User.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/users/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const user = await User.findByIdAndDelete(req.params.id);
    if (user) await Record.deleteMany({ userId: user.id });
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.get('/api/records/count', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const count = await Record.countDocuments({});
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to count records' });
  }
});

app.get('/api/payments/stats', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
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
    if (!process.env.ZENOPAY_API_KEY) return res.status(500).json({ error: 'Zenopay API key missing' });

    const rawBaseUrl = (process.env.ZENOPAY_API_URL || 'https://api.zenoapi.com').trim().replace(/\/+$/, '');
    const checkoutUrl = `${rawBaseUrl}${process.env.ZENOPAY_CHECKOUT_PATH || '/checkout/sessions'}`;

    const callbackUrl = `${process.env.APP_URL || 'https://billing-rho.vercel.app'}/records.html`;
    const payload = {
      amount, currency, description: `Water billing payment for record ${recordId}`,
      callback_url: callbackUrl,
      metadata: { recordId, customerName, customerEmail, customerPhone },
      customer: { name: customerName, email: customerEmail, phone: customerPhone }
    };

    const response = await axios.post(checkoutUrl, payload, {
      headers: { Authorization: `Bearer ${process.env.ZENOPAY_API_KEY}`, 'Content-Type': 'application/json' }
    });

    const data = response.data || {};
    const redirectUrl = data.checkoutUrl || data.redirectUrl || data.url || data.data?.checkout_url;
    res.json({ checkoutUrl: redirectUrl });
  } catch (err) {
    res.status(500).json({ error: 'Zenopay session failed' });
  }
});

app.post('/api/password-reset-request', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'Email not found' });

    const resetToken = require('crypto').randomBytes(32).toString('hex');
    const resetExpiry = Date.now() + (1 * 60 * 60 * 1000);

    user.resetToken = resetToken;
    user.resetExpiry = resetExpiry;
    await user.save();

    const resetRequest = new PasswordResetRequest({
      email: user.email, userName: user.name, resetToken, expiresAt: new Date(resetExpiry)
    });
    await resetRequest.save();

    const userEmailHtml = `<h2>Password Reset Request</h2><p>Hello ${user.name}, pending admin approval.</p>`;
    await sendEmail(user.email, 'Password Reset Request Received', userEmailHtml);

    res.json({ success: true, message: 'Submitted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed request' });
  }
});

app.get('/api/password-reset-requests', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const requests = await PasswordResetRequest.find({}).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

app.post('/api/send-notification', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const { title, body, url } = req.body;
    res.json({ success: true, message: 'Notification logged' });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

// ================== ADMIN RECORD MANAGEMENT ==================
app.get('/api/records/all', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      Record.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Record.countDocuments({})
    ]);
    res.json({ success: true, records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

app.put('/api/records/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const { name, phone, prev, curr, usage, total } = req.body;
    const updateData = { name, phone, prev, curr, usage, total };
    if (typeof prev === 'number' && typeof curr === 'number') updateData.usage = curr - prev;

    const record = await Record.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

app.delete('/api/records/:id', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    await Record.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

app.post('/api/admin/approve-password-reset', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const { requestId } = req.body;
    const resetRequest = await PasswordResetRequest.findById(requestId);
    if (!resetRequest || resetRequest.status !== 'pending') return res.status(400).json({ error: 'Invalid' });

    const newPassword = require('crypto').randomBytes(8).toString('hex').toUpperCase();
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const user = await User.findOne({ email: resetRequest.email });
    user.passwordHash = hashedPassword;
    user.passwordChangeRequired = true;
    user.tempPassword = newPassword;
    await user.save();

    resetRequest.status = 'approved';
    resetRequest.newPassword = newPassword;
    resetRequest.approvedBy = req.user.email;
    await resetRequest.save();

    await sendEmail(user.email, 'Approved Password', `Temp pass: ${newPassword}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

app.post('/api/admin/reset-user-password', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Unauthorized' });
    const { userId } = req.body;
    const user = await User.findById(userId);
    const newPassword = require('crypto').randomBytes(8).toString('hex').toUpperCase();
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordChangeRequired = true;
    user.tempPassword = newPassword;
    await user.save();

    await sendEmail(user.email, 'Reset Pass', `Pass: ${newPassword}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

app.post('/api/setup-admin', async (req, res) => {
  try {
    const adminEmail = 'mickidadyhamza@gmail.com';
    const adminPassword = 'MICKEY24@';
    let adminUser = await User.findOne({ email: adminEmail });
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    if (adminUser) {
      adminUser.passwordHash = hashedPassword;
      await adminUser.save();
    } else {
      adminUser = new User({ id: 'admin_1', name: 'Admin', email: adminEmail, passwordHash: hashedPassword, provider: 'local' });
      await adminUser.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

// ================== AUTHENTICATION ENDPOINTS ==================
app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (await User.findOne({ email: email.toLowerCase() })) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const newUser = new User({ 
      id: Date.now().toString(), 
      name, 
      email: email.toLowerCase(), 
      passwordHash: await bcrypt.hash(password, 10), 
      provider: 'local' 
    });
    await newUser.save();

    req.login(newUser, (err) => {
      if (err) return res.status(500).json({ error: 'Login error after signup' });
      return res.json({ success: true, user: newUser });
    });
  } catch (err) {
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Internal server error' });
    if (!user) return res.status(401).json({ error: info.message || 'Login failed' });

    req.login(user, (loginErr) => {
      if (loginErr) return res.status(500).json({ error: 'Session login error' });
      return res.json({ success: true, user });
    });
  })(req, res, next);
});

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// ================== 404 HANDLER ==================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found', 
    path: req.path,
    method: req.method 
  });
});

// ================== GLOBAL ERROR HANDLER ==================
app.use((err, req, res, next) => {
  log.error('Request error: ' + (err.message || JSON.stringify(err)));
  
  if (err.stack) {
    log.error('Stack trace: ' + err.stack.split('\n').slice(0, 3).join(' | '));
  }
  
  // Prevent multiple response sends
  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({ 
    error: 'Internal server error',
    message: ENV === 'development' ? err.message : undefined,
    path: req.path
  });
});

// ================== UNCAUGHT EXCEPTION HANDLER ==================
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception: ' + err.message);
  if (err.stack) {
    log.error('Stack: ' + err.stack.split('\n').slice(0, 5).join(' | '));
  }
  // Continue running - don't crash
});

// ================== UNHANDLED REJECTION HANDLER ==================
process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection: ' + (reason?.message || reason));
  // Continue running
});

// ================== STARTUP & EXPORT ==================
const startupInfo = {
  environment: ENV,
  port: PORT,
  mongodb: mongoConnected ? 'Connected' : 'Pending',
  sessionStore: sessionStoreType,
  email: emailTransporter ? 'Configured' : 'Disabled',
  timestamp: new Date().toISOString()
};

const displayStartupInfo = () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   🌊 WATER BILLING SYSTEM - ACTIVE 🌊    ║');
  console.log('╚════════════════════════════════════════════╝\n');
  console.log('📊 Configuration:');
  console.log(`   • Environment: ${startupInfo.environment}`);
  console.log(`   • Port: ${startupInfo.port}`);
  console.log(`   • Database: ${startupInfo.mongodb}`);
  console.log(`   • Session Store: ${startupInfo.sessionStore}`);
  console.log(`   • Email: ${startupInfo.email}`);
  console.log(`   • Started: ${startupInfo.timestamp}`);
  console.log('\n✅ Server ready to accept requests\n');
};

if (require.main === module) {
  try {
    const server = app.listen(PORT, () => {
      displayStartupInfo();
    });

    // Graceful shutdown
    const gracefulShutdown = (signal) => {
      log.warn(`${signal} received, shutting down gracefully...`);
      server.close(() => {
        log.info('Server closed');
        if (mongoose.connection.close) {
          mongoose.connection.close().then(() => {
            log.info('Database connection closed');
            process.exit(0);
          }).catch(() => process.exit(0));
        } else {
          process.exit(0);
        }
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (err) {
    log.error('Failed to start server: ' + err.message);
    process.exit(1);
  }
} else {
  log.info('Running as Vercel serverless function');
}

// ================== HEALTH CHECK ENDPOINT ==================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoConnected ? 'connected' : 'pending',
    sessionStore: sessionStoreType
  });
});

module.exports = app;
