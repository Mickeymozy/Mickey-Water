require('dotenv').config();

const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const compression = require('compression');
const cors = require('cors');
const nodemailer = require('nodemailer');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const fallbackUsers = new Map();
const fallbackUsersById = new Map();

const isProduction = process.env.NODE_ENV === 'production';
const adminEmails = ['mickidadyhamza@gmail.com'];

function isAdmin(email = '') {
  return adminEmails.includes(String(email).toLowerCase().trim());
}

function toSafeUser(user) {
  if (!user) return null;

  return {
    id: user._id ? user._id.toString() : user.id,
    name: user.name || 'User',
    email: user.email,
    picture: user.picture || '',
    role: user.role || (isAdmin(user.email) ? 'admin' : 'user'),
    provider: user.provider || 'local',
    phone: user.phone || ''
  };
}

function registerFallbackUser(user) {
  const email = String(user.email || '').toLowerCase().trim();
  if (email) {
    fallbackUsers.set(email, user);
  }
  if (user.id || user._id) {
    fallbackUsersById.set(String(user.id || user._id), user);
  }
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origin.includes('localhost') || origin.includes('vercel.app') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'water-billing-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true') === 'true',
  auth: {
    user: process.env.EMAIL_USER || 'mickdenzel24@gmail.com',
    pass: process.env.EMAIL_PASSWORD || 'gynitsmgxpcpdzot'
  }
});

async function sendEmail(toEmail, subject, html) {
  try {
    await emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || 'Water Billing <noreply@waterbilling.local>',
      to: toEmail,
      subject,
      html
    });
    return true;
  } catch (error) {
    console.error('SMTP error:', error.message);
    return false;
  }
}

let isMongoConnected = false;
const DEFAULT_MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/waterbilling';

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  phone: String,
  passwordHash: String,
  googleId: String,
  provider: { type: String, default: 'local' },
  picture: String,
  role: { type: String, default: 'user' },
  resetToken: String,
  resetExpiry: Date,
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now }
});

const recordSchema = new mongoose.Schema({
  userId: String,
  name: String,
  phone: String,
  prev: Number,
  curr: Number,
  usage: Number,
  total: Number,
  date: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Record = mongoose.model('Record', recordSchema);

function connectDatabaseWithRetry() {
  mongoose.set('bufferCommands', false);

  mongoose.connect(DEFAULT_MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: true,
    maxPoolSize: 5,
    socketTimeoutMS: 45000
  }).then(() => {
    isMongoConnected = true;
    console.log('MongoDB online ✅');
  }).catch((error) => {
    isMongoConnected = false;
    console.error('MongoDB unavailable, using fallback mode:', error.message);
    setTimeout(connectDatabaseWithRetry, 15000);
  });
}

connectDatabaseWithRetry();

registerFallbackUser({
  id: 'demo_user_123',
  name: 'Demo Account',
  email: 'demo@waterbilling.com',
  phone: '',
  passwordHash: bcrypt.hashSync('Demo123!', 10),
  role: 'user',
  picture: '',
  provider: 'local',
  createdAt: new Date()
});

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const normalizedEmail = String(email || '').toLowerCase().trim();
    const fallbackUser = fallbackUsers.get(normalizedEmail);

    if (!isMongoConnected) {
      if (fallbackUser) {
        const match = await bcrypt.compare(password, fallbackUser.passwordHash || '');
        if (!match) return done(null, false, { message: 'Nenosiri si sahihi.' });
        return done(null, { ...fallbackUser, _id: fallbackUser.id });
      }
      return done(null, false, { message: 'Database imeenda offline. Jaribu tena baadaye.' });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      if (fallbackUser) {
        const match = await bcrypt.compare(password, fallbackUser.passwordHash || '');
        if (!match) return done(null, false, { message: 'Nenosiri si sahihi.' });
        return done(null, { ...fallbackUser, _id: fallbackUser.id });
      }
      return done(null, false, { message: 'Akaunti haipo kwenye mfumo.' });
    }

    const match = await bcrypt.compare(password, user.passwordHash || '');
    if (!match) return done(null, false, { message: 'Nenosiri si sahihi.' });

    user.lastLogin = new Date();
    await user.save();
    return done(null, user);
  } catch (error) {
    return done(error);
  }
}));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        const email = String(profile.emails?.[0]?.value || '').toLowerCase().trim();
        user = await User.findOne({ email });
      }

      if (!user) {
        user = await User.create({
          name: profile.displayName || 'Google User',
          email: String(profile.emails?.[0]?.value || '').toLowerCase().trim(),
          googleId: profile.id,
          provider: 'google',
          picture: profile.photos?.[0]?.value || '',
          role: 'user',
          createdAt: new Date()
        });
      } else {
        user.name = user.name || profile.displayName || 'Google User';
        user.picture = user.picture || profile.photos?.[0]?.value || '';
        user.provider = user.provider || 'google';
        user.googleId = user.googleId || profile.id;
        user.lastLogin = new Date();
        await user.save();
      }

      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }));
}

passport.serializeUser((user, done) => done(null, user.id || user._id?.toString()));
passport.deserializeUser(async (id, done) => {
  try {
    const fallbackUser = fallbackUsersById.get(String(id));
    if (fallbackUser) return done(null, { ...fallbackUser, _id: fallbackUser.id });

    const user = await User.findById(id);
    return done(null, user);
  } catch (error) {
    return done(error);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Water Billing server is running', database: isMongoConnected ? 'connected' : 'fallback', time: new Date().toISOString() });
});

app.get('/', (req, res) => res.redirect('/index.html'));
app.get('/login', (req, res) => res.redirect('/login.html'));
app.get('/signup', (req, res) => res.redirect('/signup.html'));

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json({ user: toSafeUser(req.user) });
});

app.post('/api/signup', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').toLowerCase().trim();
    const phone = String(req.body?.phone || '').trim();
    const password = String(req.body?.password || '');

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Jina, barua pepe na nenosiri vinahitajika.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Nenosiri lazima liwe na angalau herufi 6.' });
    }

    if (isMongoConnected) {
      const existing = await User.findOne({ email });
      if (existing) return res.status(409).json({ error: 'Akaunti tayari ipo.' });
    } else {
      if (fallbackUsers.has(email)) return res.status(409).json({ error: 'Akaunti tayari ipo.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    if (isMongoConnected) {
      const user = await User.create({ name, email, phone, passwordHash, provider: 'local', role: isAdmin(email) ? 'admin' : 'user' });
      await sendEmail(user.email, 'Welcome to Water Billing', `<p>Habari ${user.name}, akaunti yako imeundwa vizuri.</p>`);
      return res.json({ success: true, user: toSafeUser(user) });
    }

    const userId = `offline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const user = {
      id: userId,
      name,
      email,
      phone,
      passwordHash,
      role: isAdmin(email) ? 'admin' : 'user',
      picture: '',
      provider: 'local',
      createdAt: new Date()
    };
    registerFallbackUser(user);

    return res.json({ success: true, user: toSafeUser(user), note: 'MongoDB offline; account saved in local fallback memory.' });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ error: 'Imeshindwa kuunda akaunti. Jaribu tena.' });
  }
});

app.post('/api/login', (req, res, next) => {
  passport.authenticate('local', (error, user, info) => {
    if (error) return res.status(500).json({ error: 'Imeshindwa kufanya login.' });
    if (!user) return res.status(401).json({ error: info?.message || 'Barua pepe au nenosiri si sahihi.' });

    req.login(user, async (loginError) => {
      if (loginError) return res.status(500).json({ error: 'Imeshindwa kutengeneza session.' });

      if (isMongoConnected) {
        const dbUser = await User.findById(user._id || user.id);
        if (dbUser) {
          dbUser.lastLogin = new Date();
          await dbUser.save();
        }
      }

      return res.json({ success: true, user: toSafeUser(user) });
    });
  })(req, res, next);
});

app.post('/api/logout', (req, res) => {
  req.logout(() => res.json({ success: true, message: 'Logged out' }));
});

app.post('/api/password-reset-request', async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Barua pepe inahitajika.' });

    const user = isMongoConnected ? await User.findOne({ email }) : fallbackUsers.get(email);
    if (!user) {
      return res.json({ success: true, message: 'Kwa usalama, tumejaza maelekezo kama kama akaunti ipo.' });
    }

    const token = Math.random().toString(36).slice(2, 12);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    if (isMongoConnected) {
      user.resetToken = token;
      user.resetExpiry = expiresAt;
      await user.save();
    } else {
      user.resetToken = token;
      user.resetExpiry = expiresAt;
      registerFallbackUser(user);
    }

    const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/reset.html?token=${token}&email=${encodeURIComponent(email)}`;
    await sendEmail(email, 'Reset your Water Billing password', `<p>Bonyeza kiungo hiki kuweka nenosiri jipya:</p><p><a href="${resetLink}">${resetLink}</a></p>`);

    return res.json({ success: true, message: 'Maelekezo ya kubadilisha nenosiri yamepelekwa kwenye barua pepe yako.' });
  } catch (error) {
    console.error('Password reset error:', error);
    return res.status(500).json({ error: 'Imeshindwa kutuma maelekezo ya kuondoa nenosiri.' });
  }
});

app.post('/api/password-reset', async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');

    if (!email || !token || !password || password.length < 6) {
      return res.status(400).json({ error: 'Taarifa zote zinahitajika na nenosiri lazima liwe na angalau herufi 6.' });
    }

    const user = isMongoConnected ? await User.findOne({ email }) : fallbackUsers.get(email);
    if (!user || user.resetToken !== token || !user.resetExpiry || new Date(user.resetExpiry).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Kiungo cha kubadilisha nenosiri kimeshapitwa au si sahihi.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    if (isMongoConnected) {
      user.passwordHash = passwordHash;
      user.resetToken = undefined;
      user.resetExpiry = undefined;
      await user.save();
    } else {
      const updated = { ...user, passwordHash, resetToken: undefined, resetExpiry: undefined };
      registerFallbackUser(updated);
    }

    return res.json({ success: true, message: 'Nenosiri limebadilishwa vizuri.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Imeshindwa kubadilisha nenosiri.' });
  }
});

app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google OAuth haijasanidiwa. Tumia GOOGLE_CLIENT_ID na GOOGLE_CLIENT_SECRET kwenye .env.' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (error, user) => {
    if (error || !user) {
      return res.redirect('/login.html?error=oauth');
    }
    req.logIn(user, (loginError) => {
      if (loginError) return res.redirect('/login.html?error=oauth');
      return res.redirect('/records.html');
    });
  })(req, res, next);
});

app.get('/api/records', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const user = req.user;
    const q = isAdmin(user.email) ? {} : { userId: user._id ? user._id.toString() : user.id };
    const records = await Record.find(q).sort({ createdAt: -1 });
    res.json(records.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      phone: item.phone || '-',
      prev: item.prev || 0,
      curr: item.curr || 0,
      usage: item.usage || 0,
      total: item.total || 0,
      date: item.date || item.createdAt?.toISOString().slice(0, 10),
      createdAt: item.createdAt
    })));
  } catch (error) {
    console.error('Records fetch error:', error);
    res.status(500).json({ error: 'Failed to load records' });
  }
});

app.post('/api/records', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const user = req.user;
    const record = await Record.create({
      userId: user._id ? user._id.toString() : user.id,
      name: req.body.name,
      phone: req.body.phone,
      prev: Number(req.body.prev || 0),
      curr: Number(req.body.curr || 0),
      usage: Number(req.body.usage || 0),
      total: Number(req.body.total || 0),
      date: req.body.date || new Date().toLocaleDateString('en-GB')
    });

    res.json({ success: true, record });
  } catch (error) {
    console.error('Record save error:', error);
    res.status(500).json({ error: 'Failed to save record' });
  }
});

app.get('/api/records/count', async (req, res) => {
  try {
    const count = await Record.countDocuments();
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to count records' });
  }
});

app.get('/api/users/count', async (req, res) => {
  try {
    const count = await User.countDocuments();
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to count users' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !isAdmin(req.user?.email)) {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const [totalUsers, totalRecords, pendingResets] = await Promise.all([
      User.countDocuments(),
      Record.countDocuments(),
      User.countDocuments({ resetToken: { $exists: true } })
    ]);

    res.json({ totalUsers, totalRecords, pendingResets });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

app.post('/api/admin/notify', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !isAdmin(req.user?.email)) {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const { title, body, url } = req.body || {};
    await sendEmail(process.env.EMAIL_USER || 'mickdenzel24@gmail.com', title || 'Water Billing Notification', `<h3>${title || 'Notification'}</h3><p>${body || ''}</p>${url ? `<p><a href="${url}">Open</a></p>` : ''}`);
    res.json({ success: true, message: 'Notification sent' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.get('/api/users/list', async (req, res) => {
  try {
    const users = await User.find({}, 'name email role provider createdAt').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list users' });
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
}

module.exports = app;
