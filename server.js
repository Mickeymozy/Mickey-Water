require('dotenv').config();
const express = require('express');
const path = require('path');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const compression = require('compression');
const nodemailer = require('nodemailer');
const axios = require('axios');
const MongoStore = require('connect-mongo'); // Imeongezwa kwa ajili ya usalama wa session database ikiwa online

const app = express();

const FALLBACK_USERS = [
  { _id: 'fallback-demo-user', name: 'Demo Customer', email: 'demo@waterbilling.com', password: 'Demo123!', role: 'user' },
  { _id: 'fallback-admin', name: 'System Admin', email: 'admin@waterbilling.com', password: 'admin123', role: 'admin' }
];

function findFallbackUser(email, password) {
  return FALLBACK_USERS.find((item) => item.email.toLowerCase() === String(email || '').toLowerCase() && item.password === password);
}

// ================== PROXY TRUST (MUHIMU KWA RENDER NA GOOGLE OAUTH) ==================
app.set('trust proxy', 1); 

// ================== EMAIL CONFIGURATION WITH AUTOFIX ==================
let emailTransporter;
try {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
    port: parseInt(process.env.SMTP_PORT) || 2525,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER || '',
      pass: process.env.EMAIL_PASSWORD || ''
    }
  });
} catch (err) {
  console.warn('⚠️ Autofix: Mail transporter failed to initialize. Using mock email logic.');
  emailTransporter = { sendMail: async () => ({ messageId: 'mock-id' }) };
}

const sendEmail = async (to, subject, html) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.warn('⚠️ Email sio sahihi au haipo kwenye .env. Simulizi tu ya kutuma barua pepe inafanyika.');
      return { success: true, messageId: 'simulated-id' };
    }
    const info = await emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || 'Water Billing System <noreply@waterbilling.local>',
      to: to,
      subject: subject,
      html: html
    });
    console.log('📧 Ujumbe umetumwa kwenda:', to);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('❌ Tatizo la kutuma barua pepe:', err.message);
    return { success: false, error: err.message };
  }
};

// ================== SECURITY HEADERS ==================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ================== PERFORMANCE OPTIMIZATIONS ==================
app.use(compression({ threshold: 1024, level: 6 }));

app.use((req, res, next) => {
  if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
    res.set('Cache-Control', 'public, max-age=86400');
  } else {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// ================== BASIC MIDDLEWARES ==================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(__dirname, { index: false }));

// ================== MONGODB AUTOFIX & CONNECTION ==================
let isMongoConnected = false;
const mongoOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/waterbilling', mongoOptions)
  .then(() => {
    console.log("Mongo Connected ✅");
    isMongoConnected = true;
  })
  .catch(err => {
    console.error("Mongo Connection Error ❌ Server inatumia Fallback Memory Mode sasa hivi.", err.message);
    isMongoConnected = false;
  });

// Mfumo wa kujaribu kuunganisha upya MongoDB ikijizima katikati (Autofix)
mongoose.connection.on('disconnected', () => {
  isMongoConnected = false;
  console.warn('⚠️ Database imekatika! Inajaribu kujiunganisha yenyewe...');
});
mongoose.connection.on('connected', () => {
  isMongoConnected = true;
  console.log('✅ Database imeunganishwa tena!');
});

// ================== SESSION CONFIGURATION ==================
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123_very_secure_key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/waterbilling',
    mongoOptions: mongoOptions,
    ttl: 7 * 24 * 60 * 60 // Siku 7
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

// ================== DATABASE MODELS ==================
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
  createdAt: { type: Date, default: Date.now, index: true }
});

const recordSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  name: String,
  phone: { type: String, index: true },
  prev: Number,
  curr: Number,
  usage: Number,
  total: Number,
  createdAt: { type: Date, default: Date.now, index: true }
});

const passwordResetSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  userName: String,
  resetToken: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['pending', 'approved', 'completed', 'expired'], default: 'pending' },
  createdAt: { type: Date, default: Date.now, index: true }
});

const User = mongoose.model('User', userSchema);
const Record = mongoose.model('Record', recordSchema);
const PasswordResetRequest = mongoose.model('PasswordResetRequest', passwordResetSchema);

// ================== PASSPORT LOCAL STRATEGY ==================
passport.use('local', new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    // Angalia kwanza akaunti za uokoaji (Fallback Users)
    const fallbackUser = findFallbackUser(email, password);
    if (fallbackUser) return done(null, fallbackUser);

    if (!isMongoConnected) {
      return done(null, false, { message: 'Database ipo offline. Ingia kwa kutumia Demo Account tu.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return done(null, false, { message: 'Mtumiaji hapatikani!' });
    if (!user.passwordHash) return done(null, false, { message: 'Ingia kwa kutumia Google kwenye akaunti hii.' });

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return done(null, false, { message: 'Nenosiri sio sahihi!' });

    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

// ================== PASSPORT GOOGLE STRATEGY (FIXED CALLBACK URL 404) ==================
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || 'https://mickey-glitch.onrender.com/auth/google/callback';

passport.use('google', new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || 'dummy-client-id',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'dummy-secret',
  callbackURL: googleCallbackUrl,
  proxy: true 
}, async (accessToken, refreshToken, profile, done) => {
  try {
    if (!isMongoConnected) {
      return done(new Error('Database ipo offline kwa sasa, Google Login haifanyi kazi.'));
    }

    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('Email inahitajika kutoka Google.'));

    let user = await User.findOne({ googleId: profile.id });

    if (!user) {
      const existingByEmail = await User.findOne({ email: email.toLowerCase() });
      if (existingByEmail) {
        existingByEmail.googleId = profile.id;
        existingByEmail.picture = profile.photos?.[0]?.value || existingByEmail.picture;
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
      await user.save();
    }
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user._id || user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const fallbackUser = FALLBACK_USERS.find((item) => item._id === id);
    if (fallbackUser) return done(null, fallbackUser);

    if (!isMongoConnected) return done(null, FALLBACK_USERS[0]); // Autofix: tumia demo kama db imezima

    const user = await User.findById(id).lean();
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

// ================== MIDDLEWARES ZA ULINZI ==================
const protect = (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: "Ruhusa inahitajika. Tafadhali log in upya." });
  }
  next();
};

const adminEmails = ['mickidadyhamza@gmail.com'];
const isAdmin = (user) => user && (adminEmails.includes(user.email) || user.role === 'admin');

// ================== USER & ADMIN AUTH ENDPOINTS ==================
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.user });
});

// Mfumo thabiti wa Sign Up oline kwenye Mongoose Database
app.post('/api/signup', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ error: 'Mfumo upo kwenye matengenezo (Database Offline). Jaribu baadae kidogo.' });
    }

    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Tafadhali jaza nafasi zote.' });

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) return res.status(409).json({ error: 'Email hii imeshasajiliwa tayari.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      id: Date.now().toString(),
      name,
      email: email.toLowerCase(),
      passwordHash: hashedPassword,
      provider: 'local'
    });
    
    await newUser.save();

    req.login(newUser, (err) => {
      if (err) return res.status(500).json({ error: 'Imeshindwa kutengeneza kikao kipya.' });
      res.json({ success: true, user: { id: newUser._id, name: newUser.name, email: newUser.email } });
    });
  } catch (err) {
    res.status(500).json({ error: 'Tatizo la ndani ya server wakati wa kusajili.' });
  }
});

const handleLocalLogin = (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Server Login error' });
    if (!user) return res.status(401).json({ error: info?.message || 'Email au password sio sahihi.' });

    req.login(user, async (loginErr) => {
      if (loginErr) return res.status(500).json({ error: 'Kikao kimefeli.' });

      if (user && user._id && !String(user._id).startsWith('fallback-') && isMongoConnected) {
        await User.findByIdAndUpdate(user._id, { lastLogin: new Date() }).catch(() => {});
      }

      res.json({
        success: true,
        user: {
          id: user._id || user.id,
          email: user.email,
          name: user.name,
          role: isAdmin(user) ? 'admin' : 'user'
        }
      });
    });
  })(req, res, next);
};

app.post('/api/login', handleLocalLogin);
app.post('/local-login', handleLocalLogin);

// ================== GOOGLE ROUTING (FIXED AND LINKED) ==================
app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'not-configured') {
    return res.redirect('/login.html?error=' + encodeURIComponent('Google Client ID is missing in server environment variables.'));
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: true }, (err, user, info) => {
    if (err) return res.redirect(`/login.html?error=${encodeURIComponent(err.message)}`);
    if (!user) return res.redirect('/login.html?error=Mtumiaji-hakupatikana');

    req.login(user, (loginErr) => {
      if (loginErr) return res.redirect('/login.html?error=SessionError');
      // Kama ni Admin mpeleke admin.html, la sivyo mpeleke records.html
      const destination = isAdmin(user) ? '/admin.html' : '/records.html';
      res.redirect(destination);
    });
  })(req, res, next);
});

app.get('/api/logout', (req, res) => {
  req.logout(() => { res.json({ success: true }); });
});
app.get('/logout', (req, res) => {
  req.logout(() => { res.redirect('/login.html'); });
});

// ================== ADMIN SPECIFIC ENDPOINTS ==================
app.get('/api/admin/stats', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Ufikiaji Umekataliwa! Ukurasa huu ni kwa ajili ya admin tu.' });
    
    if (!isMongoConnected) {
      return res.json({ totalUsers: 1, totalRecords: 0, pendingResets: 0, offline: true });
    }

    const [totalUsers, totalRecords, pendingResets] = await Promise.all([
      User.countDocuments({}),
      Record.countDocuments({}),
      PasswordResetRequest.countDocuments({ status: 'pending' })
    ]);

    res.json({ totalUsers, totalRecords, pendingResets });
  } catch (err) {
    res.status(500).json({ error: 'Imeshindwa kupata Takwimu.' });
  }
});

app.post('/api/admin/notify', protect, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Ufikiaji Umekataliwa.' });
    res.json({ success: true, message: 'Tangazo limetumwa kikamilifu.' });
  } catch (err) {
    res.status(500).json({ error: 'Imeshindwa kutuma tangazo.' });
  }
});

// ================== DATA MANAGEMENT (RECORDS) ==================
app.post('/save-record', protect, async (req, res) => {
  try {
    if (!isMongoConnected) return res.status(503).json({ error: 'Database ipo offline kwa sasa.' });
    
    const { curr, prev, name, phone, rate, fixed } = req.body;
    const usage = curr - prev;
    const total = (usage * (rate || 2000)) + (fixed || 0);
    const userId = req.user._id || req.user.id;

    const record = new Record({ userId: String(userId), name, phone, prev, curr, usage, total });
    await record.save();

    res.json({ success: true, record });
  } catch (e) {
    res.status(500).json({ error: "Imeshindwa kuhifadhi rekodi." });
  }
});

app.get('/get-records', protect, async (req, res) => {
  try {
    if (!isMongoConnected) return res.json({ success: true, records: [], note: 'Offline' });

    const userId = req.user._id || req.user.id;
    const query = isAdmin(req.user) ? {} : { userId: String(userId) };

    const records = await Record.find(query).sort({ createdAt: -1 }).lean();
    res.json({ success: true, records });
  } catch (e) {
    res.status(500).json({ error: "Imeshindwa kupata rekodi." });
  }
});

// ================== WEB PAGE ROUTES (IMEPUNGUZWA BOTWEB NA MAIN) ==================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/records.html', protect, (req, res) => res.sendFile(path.join(__dirname, 'records.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));

app.get('/admin.html', protect, (req, res) => {
  if (!isAdmin(req.user)) {
    // Kama mtu sio admin na anajaribu kuingia hapa, mfumo unamzuia mapema
    return res.status(403).sendFile(path.join(__dirname, 'login.html'));
  }
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Setup admin endpoint wa haraka
app.post('/api/setup-admin', async (req, res) => {
  try {
    if (!isMongoConnected) return res.status(503).json({ error: 'Database Offline' });
    const adminEmail = 'mickidadyhamza@gmail.com';
    const hashedPassword = await bcrypt.hash('MICKEY24@', 10);

    await User.findOneAndUpdate(
      { email: adminEmail },
      { name: 'Mickey Admin', passwordHash: hashedPassword, provider: 'local' },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Admin setup successful.' });
  } catch (err) {
    res.status(500).json({ error: 'Setup failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', database: isMongoConnected ? 'online' : 'offline' }));

// Global error handlers
app.use((err, req, res, next) => {
  console.error("💥 Server Error:", err.message);
  res.status(500).json({ error: 'Itifaki imefeli, matatizo ya kiufundi kwenye server.' });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'login.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server fully operational on port ${PORT}`);
});

module.exports = app;
