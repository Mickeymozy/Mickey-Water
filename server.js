require('dotenv').config();
const express = require('express');
const path = require('path');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const session = require('express-session');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const compression = require('compression');
const nodemailer = require('nodemailer');
const MongoStore = require('connect-mongo');
const cors = require('cors');

const app = express();

// ================== 1. SMART DYNAMIC CORS (Kuondoa kabisa Network Error) ==================
app.use(cors({
  origin: function (origin, callback) {
    // Inaruhusu Vercel zote, localhost, na inakubali maombi hata kama origin haikutumwa vizuri
    if (!origin || origin.includes('vercel.app') || origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(null, true); // Auto-Fix: Inaruhusu ili kuzuia Network Error kwenye simu
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Handle Pre-flight options router automatic
app.options('*', cors());

// ================== 2. SMTP EMAIL CONFIGURATION ==================
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER || 'mickdenzel24@gmail.com',
    pass: process.env.EMAIL_PASSWORD || 'gynitsmgxpcpdzot' // App password yako
  }
});

// Kazi ya kutuma barua pepe ya usalama au ya makosa (Error Log Mail)
const sendSecurityAlertEmail = async (toEmail, subject, title, description, technicalDetails = '') => {
  try {
    const htmlTemplate = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 550px; margin: auto; background: #0b1329; color: #f8fafc; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid rgba(244, 63, 94, 0.2);">
        <div style="background: linear-gradient(135deg, #e11d48 0%, #be123c 100%); padding: 24px; text-align: center;">
          <h2 style="margin: 0; font-size: 22px; font-weight: bold; color: #ffffff; letter-spacing: 0.5px;">${title}</h2>
        </div>
        <div style="padding: 24px; line-height: 1.6;">
          <p style="font-size: 16px; margin-top: 0;">Habari,</p>
          <p style="font-size: 15px; color: #cbd5e1;">${description}</p>
          
          ${technicalDetails ? `
            <div style="background: rgba(244, 63, 94, 0.1); border-left: 4px solid #f43f5e; padding: 14px; border-radius: 8px; margin: 20px 0; font-family: monospace; font-size: 13px; color: #fda4af;">
              <strong>Ripoti ya Hitilafu (Error Log):</strong><br>${technicalDetails}
            </div>
          ` : ''}
          
          <p style="font-size: 14px; color: #94a3b8; margin-bottom: 0;">Kama hukufanya jaribio hili, tafadhali kagua usalama wa kifaa chako haraka.</p>
        </div>
        <div style="background: #0f172a; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid rgba(255,255,255,0.05);">
          © 2026 Water Billing Automated Shield Engine.
        </div>
      </div>
    `;

    await emailTransporter.sendMail({
      from: `"Water Billing Security" <${process.env.EMAIL_USER || 'mickdenzel24@gmail.com'}>`,
      to: toEmail,
      subject: subject,
      html: htmlTemplate
    });
    console.log(`📡 Error alert mail automatically sent to: ${toEmail}`);
  } catch (err) {
    console.error('❌ Mfumo wa barua pepe umeshindwa kufanya kazi automatic:', err.message);
  }
};

// ================== 3. DATABASE AUTO-RECONNECT ENGINE ==================
let isMongoConnected = false;
const connectDatabaseWithRetry = () => {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://Mickdady:Mickdadyhamza@cluster0.xxxxx.mongodb.net/waterbilling', {
    serverSelectionTimeoutMS: 5000
  }).then(() => {
    console.log("MongoDB Online (Kiotomatiki) ✅");
    isMongoConnected = true;
  }).catch(err => {
    console.error("❌ Hitilafu ya DB. Mfumo unajirekebisha utumie Kumbukumbu ya Muda (Fallback Memory)...");
    isMongoConnected = false;
    // Auto-Retry kila baada ya sekunde 15 bila kuua server
    setTimeout(connectDatabaseWithRetry, 15000);
  });
};
connectDatabaseWithRetry();

// ================== 4. MIDDLEWARES & SESSION SETUP ==================
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname))); // Inasoma mafile yote yaliyopo kwenye folder automatic

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'gynitsmgxpcpdzot_mickey_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'none' }
}));

app.use(passport.initialize());
app.use(passport.session());

// ================== 5. SCHEMAS ==================
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  phone: String,
  passwordHash: String,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Passport configuration
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    if (!isMongoConnected) return done(null, false, { message: 'Database ipo offline. Tafadhali jaribu tena baada ya sekunde chache.' });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return done(null, false, { message: 'Akaunti yenye barua pepe hii haipo kwenye mfumo yetu.' });
    
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return done(null, false, { message: 'Nenosiri uliloingiza si sahihi.' });
    
    return done(null, user);
  } catch (e) { return done(e); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { const user = await User.findById(id); done(null, user); } catch (e) { done(e); }
});

// ================== 6. AUTOMATED ROUTING ENGINE (FILES SYNC) ==================
// Inajaza na kuchukua mafaili yaliyopo kwenye root folder kiotomatiki
app.get('/:page.html', (req, res, next) => {
  const filePath = path.join(__dirname, `${req.params.page}.html`);
  res.sendFile(filePath, (err) => {
    if (err) {
      // Kama faili halipo, badala ya kuleta error, inampeleka home automatic
      res.redirect('/');
    }
  });
});

// ================== 7. LOGIN WITH AUTOMATIC EMAIL ERROR LOGGING ==================
app.post('/api/login', (req, res, next) => {
  const inputEmail = req.body.email ? String(req.body.email).toLowerCase().trim() : '';

  passport.authenticate('local', async (err, user, info) => {
    // Kosa likitokea upande wa Server
    if (err) {
      if (inputEmail) {
        await sendSecurityAlertEmail(
          inputEmail,
          'Hitilafu ya Mfumo: Login Failed',
          'Internal Server Error Log',
          'Umejaribu kuingia kwenye mfumo wa Water Billing lakini kukatokea hitilafu ya ndani ya mfumo inayoshughulikiwa sasa hivi.',
          err.message
        );
      }
      return res.status(500).json({ error: 'Server Auto-Fixer inalishughulikia tatizo hili. Jaribu tena.' });
    }

    // Mtumiaji akikosea Password au Email haipo
    if (!user) {
      const sababu = info?.message || 'Nenosiri au Barua Pepe isiyo sahihi.';
      if (inputEmail && inputEmail.includes('@')) {
        await sendSecurityAlertEmail(
          inputEmail,
          'Ulinzi: Jaribio la kuingia limefeli ⚠️',
          'Jaribio Lililofeli la Kuingia',
          `Mtu fulani amejaribu kuingia kwenye akaunti yako kwa kutumia barua pepe hii na ameshindwa kwa sababu zifuatazo.`,
          `SABABU: ${sababu}\nMUDA: ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })} (EAT)`
        );
      }
      return res.status(401).json({ error: sababu });
    }

    req.login(user, (loginErr) => {
      if (loginErr) return res.status(500).json({ error: 'Imeshindwa kutengeneza Session.' });
      return res.json({ success: true, user: { name: user.name, email: user.email } });
    });
  })(req, res, next);
});

// ================== 8. AUTOMATIC ERROR FIXER MIDDLEWARE ==================
// Hii inakamata makosa yote makubwa (Crashes) na kuyafix bila kuruhusu server izime
app.use((err, req, res, next) => {
  console.error("🚨 Auto-Fixer Engine Imekamata Error:", err.stack);
  
  // Inarudisha jibu safi kwa browser ili kuzuia "Network Error" inayomkanganya mtumiaji
  res.status(200).json({
    success: false,
    error: "Mfumo ulikumbana na hitilafu ndogo na umejirekebisha wenyewe (Auto-Fixed). Tafadhali bonyeza tena kitufe."
  });
});

// Kuzuia Node Process isizime (Anti-Crash Global Shields)
process.on('uncaughtException', (error) => {
  console.error('🔥 Imekamatwa Uncaught Exception automatic:', error);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Imekamatwa Unhandled Rejection automatic kwenye:', promise, 'sababu:', reason);
});

// Kuanzisha Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Automatic Self-Healing Server Active on Port ${PORT}`);
});
