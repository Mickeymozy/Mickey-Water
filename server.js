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
const MongoStore = require('connect-mongo');
const crypto = require('crypto');
const cors = require('cors'); // Muhimu ili kuruhusu Vercel Frontend kuongea na Render Backend

const app = express();

// ================== CORS CONFIGURATION (FIX YA NETWORK/SERVER ERROR) ==================
const ALLOWED_ORIGINS = [
  'https://billing-rho.vercel.app',
  'http://localhost:3000',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

const FALLBACK_USERS = [
  { _id: 'fallback-demo-user', name: 'Demo Customer', email: 'demo@waterbilling.com', password: 'Demo123!', role: 'user' },
  { _id: 'fallback-admin', name: 'System Admin', email: 'admin@waterbilling.com', password: 'admin123', role: 'admin' }
];

function findFallbackUser(email, password) {
  return FALLBACK_USERS.find((item) => item.email.toLowerCase() === String(email || '').toLowerCase() && item.password === password);
}

app.set('trust proxy', 1); 

// ================== SMTP EMAIL CONFIGURATION ==================
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true' || parseInt(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Kazi ya kutuma Email
const sendSystemEmail = async (to, subject, htmlContent) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.warn('⚠️ SMTP Credentials hazijajazwa kwenye .env');
      return { success: false, error: 'Email configuration missing' };
    }
    const mailOptions = {
      from: process.env.EMAIL_FROM || `"Water Billing System" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html: htmlContent
    };
    const info = await emailTransporter.sendMail(mailOptions);
    console.log(`📧 Email imetumwa kwenda ${to} | ID: ${info.messageId}`);
    return { success: true };
  } catch (err) {
    console.error('❌ SMTP Mail Error:', err.message);
    return { success: false, error: err.message };
  }
};

// ================== PERFORMANCE & BASIC MIDDLEWARES ==================
app.use(compression({ threshold: 1024, level: 6 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(__dirname, { index: false }));

// ================== MONGODB CONNECTION WITH AUTOFIX ==================
let isMongoConnected = false;
const mongoOptions = { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 };

mongoose.connect(process.env.MONGODB_URI, mongoOptions)
  .then(() => { console.log("Mongo Connected ✅"); isMongoConnected = true; })
  .catch(err => { console.error("Mongo Error ❌ Inatumia Local Memory Fallback.", err.message); isMongoConnected = false; });

mongoose.connection.on('disconnected', () => { isMongoConnected = false; });
mongoose.connection.on('connected', () => { isMongoConnected = true; });

// ================== SESSION MANAGEMENT ==================
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey_waterbilling',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    mongoOptions: mongoOptions,
    ttl: 7 * 24 * 60 * 60
  }),
  cookie: { 
    secure: true, // Lazima iwe true kama unatumia Vercel/HTTPS externa backend
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'none' // Muhimu kwa cross-origin kati ya Vercel na Render Backend
  },
  name: 'waterBillingSid'
}));

app.use(passport.initialize());
app.use(passport.session());

// ================== SCHEMAS & MODELS (FIXED TO INCLUDE PHONE) ==================
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, index: true, unique: true, required: true },
  phone: { type: String, index: true }, // Imeongezwa kurekebisha kosa la kwenye picha ya usajili
  passwordHash: String,
  provider: { type: String, default: 'local' },
  googleId: String,
  picture: String,
  otpCode: String,          // Inatumika kurejesha nenosiri
  otpExpiry: Date,         // Muda wa kuisha kwa nambari ya siri ya OTP
  lastLogin: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const recordSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  name: String,
  phone: String,
  prev: Number,
  curr: Number,
  usage: Number,
  total: Number,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Record = mongoose.model('Record', recordSchema);

// ================== PASSPORT AUTH STRATEGIES ==================
passport.use('local', new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (email, password, done) => {
  try {
    const fallbackUser = findFallbackUser(email, password);
    if (fallbackUser) return done(null, fallbackUser);

    if (!isMongoConnected) return done(null, false, { message: 'Database ipo offline. Tumia Demo account.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return done(null, false, { message: 'Akaunti hii haijasajiliwa.' });
    if (!user.passwordHash) return done(null, false, { message: 'Tafadhali ingia kwa kutumia Google.' });

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return done(null, false, { message: 'Nenosiri uliloingiza si sahihi.' });

    return done(null, user);
  } catch (err) { return done(err); }
}));

// ================== GOOGLE STRATEGY ==================
passport.use('google', new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'https://mickey-glitch.onrender.com/auth/google/callback',
  proxy: true 
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('Google profile is missing email address'));

    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.findOne({ email: email.toLowerCase() });
      if (user) {
        user.googleId = profile.id;
        user.picture = profile.photos?.[0]?.value || user.picture;
        await user.save();
      } else {
        user = new User({
          name: profile.displayName,
          email: email.toLowerCase(),
          googleId: profile.id,
          picture: profile.photos?.[0]?.value,
          provider: 'google'
        });
        await user.save();
      }
    }
    return done(null, user);
  } catch (err) { return done(err); }
}));

passport.serializeUser((user, done) => done(null, user._id || user.id));
passport.deserializeUser(async (id, done) => {
  const fallback = FALLBACK_USERS.find(u => u._id === id);
  if (fallback) return done(null, fallback);
  try {
    const user = await User.findById(id).lean();
    done(null, user || false);
  } catch (err) { done(err); }
});

const protect = (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Ruhusa inahitajika. Ingia kwenye akaunti.' });
  next();
};

// ================== AUTHENTICATION ENDPOINTS WITH SMTP EMAIL TRIGGERS ==================

// 1. SIGNUP ENDPOINT (FIXED ACCORDING TO SCREENSHOT EXTRA FIELDS)
app.post('/api/signup', async (req, res) => {
  try {
    if (!isMongoConnected) return res.status(503).json({ error: 'Database ipo nje ya mtandao kwa sasa.' });

    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Tafadhali jaza nafasi zote muhimu.' });

    const userExist = await User.findOne({ email: email.toLowerCase() });
    if (userExist) return res.status(409).json({ error: 'Email hii imesajiliwa tayari.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      name,
      email: email.toLowerCase(),
      phone: phone || '', // Imehifadhiwa sasa kwenye DB ili kuzuia 500 au crash Error
      passwordHash: hashedPassword,
      provider: 'local'
    });

    await newUser.save();

    // TUMA EMAIL YA KUFANIKIWA KUFUNGUA AKAUNTI (SMTP)
    const emailHtml = `
      <div style="font-family: sans-serif; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #38bdf8;">Habari ${name},</h2>
        <p>Akaunti yako kwenye mfumo wa <strong>Water Billing</strong> imetengenezwa kwa mafanikio makubwa.</p>
        <p>Sasa unaweza kuingia na kuanza kudhibiti ankara na rekodi zako za maji kwa urahisi kabisa.</p>
        <br><hr style="border-color: rgba(255,255,255,0.1)"><br>
        <p style="font-size: 12px; color: #94a3b8;">Huu ni ujumbe wa otomatiki, tafadhali usijibu.</p>
      </div>`;
    await sendSystemEmail(newUser.email, 'Karibu Kwenye Mfumo - Akaunti Yako Iko Tayari!', emailHtml);

    req.login(newUser, (err) => {
      if (err) return res.status(500).json({ error: 'Imeshindwa kutengeneza kikao kipya.' });
      return res.json({ success: true, user: { name: newUser.name, email: newUser.email } });
    });
  } catch (err) {
    res.status(500).json({ error: 'Server Error wakati wa kutengeneza akaunti.' });
  }
});

// 2. LOGIN ENDPOINT WITH NOTIFICATION EMAIL
app.post('/api/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Tatizo la ndani ya server.' });
    if (!user) return res.status(401).json({ error: info?.message || 'Barua pepe au nenosiri lisilo sahihi.' });

    req.login(user, async (loginErr) => {
      if (loginErr) return res.status(500).json({ error: 'Kikao kimefeli.' });

      if (user._id && !String(user._id).startsWith('fallback-') && isMongoConnected) {
        const loginTime = new Date();
        await User.findByIdAndUpdate(user._id, { lastLogin: loginTime });

        // TUMA EMAIL YA SIKU/MUDA WA KUINGIA (SMTP ALERT)
        const loginHtml = `
          <div style="font-family: sans-serif; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
            <h3 style="color: #22c55e;">Uingiaji Mpya Kwenye Akaunti!</h3>
            <p>Habari ${user.name || user.email},</p>
            <p>Mtu fulani ameingia kwenye akaunti yako ya Water Billing hivi sasa.</p>
            <p><strong>Muda:</strong> ${loginTime.toString()}</p>
            <p>Kama sio wewe, tafadhali badilisha nenosiri lako haraka iwezekanavyo.</p>
          </div>`;
        await sendSystemEmail(user.email, 'Tahadhari: Akaunti yako imefunguliwa hivi sasa', loginHtml);
      }

      return res.json({ success: true, user: { id: user._id, name: user.name, email: user.email } });
    });
  })(req, res, next);
});

// ================== GOOGLE LOGIN ROUTES ==================
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: true }, (err, user) => {
    if (err || !user) return res.redirect(`${process.env.FRONTEND_URL || 'https://billing-rho.vercel.app'}/login.html?error=AuthFailed`);
    req.login(user, (loginErr) => {
      if (loginErr) return res.redirect(`${process.env.FRONTEND_URL || 'https://billing-rho.vercel.app'}/login.html?error=SessionError`);
      res.redirect(`${process.env.FRONTEND_URL || 'https://billing-rho.vercel.app'}/records.html`);
    });
  })(req, res, next);
});

// ================== ADVANCED OTP PASSWORD RESET SYSTEM (SMTP) ==================

// Hatua ya 1: Omba OTP Code kwenye barua pepe
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Tafadhali weka email yako.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'Barua pepe hii haipatikani kwenye mfumo wetu.' });

    // Tengeneza namba za siri za OTP (Namba 6 za siri)
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.otpCode = otpCode;
    user.otpExpiry = Date.now() + 15 * 60 * 1000; // OTP itadumu kwa dakika 15 tu
    await user.save();

    // Tuma namba ya siri kwa njia ya barua pepe
    const otpHtml = `
      <div style="font-family: sans-serif; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px; text-align: center;">
        <h2 style="color: #38bdf8;">Nambari ya Uhakiki (OTP)</h2>
        <p>Umeomba kubadilisha nenosiri lako. Tumia nambari ya siri hapa chini ili kukamilisha mchakato:</p>
        <div style="background: rgba(56, 189, 248, 0.1); padding: 15px; font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #38bdf8; display: inline-block; margin: 15px auto; border-radius: 8px;">
          ${otpCode}
        </div>
        <p style="color: #94a3b8; font-size: 13px;">Nambari hii itaisha nguvu baada ya dakika 15.</p>
      </div>`;
    
    await sendSystemEmail(user.email, 'Uhakiki wa OTP - Ombi la Kubadilisha Nenosiri', otpHtml);
    res.json({ success: true, message: 'Nambari ya OTP imetumwa kwenye barua pepe yako.' });
  } catch (err) {
    res.status(500).json({ error: 'Imeshindwa kukamilisha ombi la nambari ya siri.' });
  }
});

// Hatua ya 2: Uhakiki wa OTP na Uwekaji wa Nenosiri Jipya
app.post('/api/reset-password-otp', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ error: 'Tafadhali jaza nafasi zote.' });

    const user = await User.findOne({ 
      email: email.toLowerCase(),
      otpCode: otp,
      otpExpiry: { $gt: Date.now() }
    });

    if (!user) return res.status(400).json({ error: 'Nambari ya OTP si sahihi au muda wake umeisha.' });

    // Hifadhi nenosiri jipya lililowekwa na mtumiaji
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.otpCode = undefined; // Futa kabisa OTP iliyotumika
    user.otpExpiry = undefined;
    await user.save();

    // TUMA NENOSIRI JIPYA LILILOWEKWA KWENYE EMAIL KAMA RECORD/KUMBUKUMBU
    const alertNewPassHtml = `
      <div style="font-family: sans-serif; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h3 style="color: #22c55e;">Nenosiri Lako Limebadilishwa Kikamilifu!</h3>
        <p>Habari ${user.name},</p>
        <p>Mabadiliko ya nenosiri lako yamefanyika kwa usalama. Kumbukumbu ya nenosiri lako jipya ni hili hapa chini:</p>
        <p><strong>Nenosiri Jipya:</strong> <span style="background:#334155; padding:4px 8px; border-radius:4px;">${newPassword}</span></p>
        <p style="color:#f59e0b; font-size:13px;">Tafadhali futa barua pepe hii baada ya kuisoma ili kulinda usalama wa akaunti yako.</p>
      </div>`;
    await sendSystemEmail(user.email, 'Taarifa: Nenosiri jipya limewekwa kikamilifu', alertNewPassHtml);

    res.json({ success: true, message: 'Nenosiri lako jipya limesasishwa, na kumbukumbu imetumwa kwenye barua pepe yako.' });
  } catch (err) {
    res.status(500).json({ error: 'Imeshindwa kubadilisha nenosiri.' });
  }
});

// ================== APP ENTRY POINT ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Secure Online Backend Active on Port ${PORT}`);
});

module.exports = app;
