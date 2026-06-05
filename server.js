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

// ================== PROXY TRUST (FIX KWA AJILI YA RENDER) ==================
app.set('trust proxy', 1); 

// ================== EMAIL CONFIGURATION ==================
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

const sendEmail = async (to, subject, html) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.warn('⚠️  Email not configured. Set EMAIL_USER and EMAIL_PASSWORD in .env');
      return { success: false, error: 'Email service not configured' };
    }

    const info = await emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || 'Water Billing System <noreply@waterbilling.local>',
      to: to,
      subject: subject,
      html: html
    });
    console.log('📧 Email sent to:', to, '| MessageID:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('❌ Email send error:', err.message);
    return { success: false, error: err.message };
  }
};

// ================== SECURITY HEADERS ==================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ================== PERFORMANCE OPTIMIZATIONS ==================
app.use(compression({ threshold: 1024, level: 6 }));

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

// ================== BASIC MIDDLEWARES ==================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(__dirname, { 
  maxAge: '24h',
  etag: false,
  index: false
}));

// ================== MONGODB CONNECTION ==================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/water_billing';
mongoose.connect(MONGODB_URI)
  .then(() => console.log("Mongo Connected ✅"))
  .catch(err => console.log("Mongo Error ❌", err));

// FIX YA MONGOOSE V8 (MTAZAMO SALAMA WA QUERIES)
mongoose.set('strictQuery', true);

// ================== SESSION CONFIGURATION WITH MONGOSTORE ==================
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false, 
  saveUninitialized: false, 
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'sessions'
  }),
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  },
  name: 'waterBillingSid'
}));

app.use(passport.initialize());
app.use(passport.session());

// ================== MODELS WITH INDEXES ==================
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
  userId: { type: String, index: true }, // ID ya Admin aliyeweka rekodi
  date: String, 
  name: String,
  phone: { type: String, index: true }, // Hapa ndipo Admin anaweka Email ya mteja ili mteja aione
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

streamAnalyticsSchema.index({ sessionId: 1, timestamp: -1 });
streamAnalyticsSchema.index({ userId: 1, timestamp: -1 });
streamAnalyticsSchema.index({ channel: 1, timestamp: -1 });
streamAnalyticsSchema.index({ event: 1, timestamp: -1 });

const User = mongoose.model('User', userSchema);
const Record = mongoose.model('Record', recordSchema);
const PasswordResetRequest = mongoose.model('PasswordResetRequest', passwordResetSchema);
const StreamAnalytics = mongoose.model('StreamAnalytics', streamAnalyticsSchema);

// ================== PASSPORT STRATEGIES ==================
passport.use('local', new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return done(null, false, { message: 'User not found' });

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return done(null, false, { message: 'Invalid password' });

    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.use('google', new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || 'not-configured',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'not-configured',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'https://mickey-glitch.onrender.com/auth/google/callback',
  proxy: true 
}, async (accessToken, refreshToken, profile, done) => {
  try {
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

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    if (!id) return done(null, false);
    const user = await User.findById(id).lean();
    if (!user) return done(null, false);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// ================== AUTH MIDDLEWARE ==================
const protect = (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const adminEmails = ['mickidadyhamza@gmail.com'];
const isAdmin = (user) => user && adminEmails.includes(user.email);

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({});
  res.json({ user: req.user });
});

// ================== RECORDS ENDPOINTS (KWA AJILI YA RECORDS.HTML) ==================
// MABADILIKO MAKUBWA YA MFUMO WA MAONI (RECORDS VISIBILITY) YA MTUMIAJI NA ADMIN
app.get('/api/records', protect, async (req, res) => {
  try {
    let query = {};
    
    if (!isAdmin(req.user)) {
      // Kama ni mteja wa kawaida, anaona tu rekodi ambazo Admin alijaza email yake kwenye field ya phone
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
    
    // Inasave rekodi ikionyesha nani ameitengeneza (Admin) na namba/email ya mfafanuzi (phone)
    const newRecord = new Record({
      userId: req.user._id.toString(), 
      date,
      name,
      phone: phone ? phone.toLowerCase() : '', // Inahifadhi kwa herufi ndogo ili kurahisisha utafutaji (query)
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

    const callbackUrl = `${process.env.APP_URL || 'http://localhost:3000'}/records.html`;
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

// ================== AUTHENTICATION ENDPOINTS (SASA ZIPO KAMILI) ==================
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

// ================== WASHA SEVA ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Seva ipo hewani kwenye port ${PORT} 🚀`));
