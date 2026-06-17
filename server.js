// server.js
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { v4: uuidv4 } = require('uuid');

const app = express();
const DB_FILE = './database.sqlite';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

app.use(express.json());

let db;

// Initialize database
async function initDb() {
  db = await open({ filename: DB_FILE, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      fullname TEXT NOT NULL,
      user_type TEXT NOT NULL DEFAULT 'customer',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
  `);
}

// Generate JWT
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, user_type: user.user_type },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Middleware: authenticate token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// Signup route
app.post('/api/auth/signup', async (req, res) => {
  const { fullname, email, password } = req.body;
  if (!fullname || !email || !password)
    return res.status(400).json({ error: 'All fields are required' });

  const exists = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (exists) return res.status(409).json({ error: 'Email already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const userId = uuidv4();
  const now = new Date().toISOString();

  await db.run(
    'INSERT INTO users (id, email, password, fullname, user_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, email, hashed, fullname, 'customer', 'active', now]
  );

  res.status(201).json({ message: 'Account created successfully. Please login.' });
});

// Login route
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required' });

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status === 'suspended')
    return res.status(403).json({ error: 'Account suspended' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = generateToken(user);
  res.json({
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      email: user.email,
      fullname: user.fullname,
      user_type: user.user_type
    }
  });
});

// Example protected route
app.get('/api/profile', authenticateToken, async (req, res) => {
  const user = await db.get(
    'SELECT id, email, fullname, user_type FROM users WHERE id = ?',
    [req.user.id]
  );
  res.json(user);
});

// Start server
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () =>
    console.log(`🚀 Server running on http://localhost:${PORT}`)
  );
});
