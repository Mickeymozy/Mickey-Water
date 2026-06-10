require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const cors = require('cors');

const app = express();

// Path ya file la JSON la kuhifadhi data za records
const DATA_FILE = path.join(__dirname, 'records_db.json');

// Kazi ya kuhakikisha file la JSON lipo na lina muundo sahihi
const initializeDatabase = () => {
  if (!fs.existsSync(DATA_FILE)) {
    const initialData = {
      records: [],
      system_logs: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf8');
    console.log("💾 File jipya la JSON (records_db.json) limetengenezwa kiotomatiki.");
  }
};
initializeDatabase();

// Kazi za kusoma na kuandika kwenye JSON (Helper Functions)
const readData = () => {
  try {
    initializeDatabase();
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error("🚨 Hitilafu ya kusoma JSON:", err);
    return { records: [], system_logs: [] };
  }
};

const writeData = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error("🚨 Hitilafu ya kuandika kwenye JSON:", err);
    return false;
  }
};

// Middlewares
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', credentials: true }));

// Serve static web files kutoka kwenye root folder automatic
app.use(express.static(path.join(__dirname)));

// ================== API ENDPOINTS (RECORDS ONLY) ==================

// 1. Kuchukua records zote (GET)
app.get('/api/records', (req, res) => {
  const db = readData();
  res.json({ success: true, data: db.records });
});

// 2. Kuongeza record mpya (POST)
app.post('/api/records', (req, res) => {
  const { name, amount, status, phone, deviceMetrics } = req.body;
  
  if (!name || !amount) {
    return res.status(400).json({ success: false, error: "Jina na Kiasi (Amount) vinahitajika!" });
  }

  const db = readData();
  
  const newRecord = {
    id: 'REC_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    name,
    amount: Number(amount),
    status: status || 'Pending',
    phone: phone || 'N/A',
    deviceMetrics: deviceMetrics || {},
    createdAt: new Date().toISOString()
  };

  db.records.push(newRecord);
  
  // Kuandika log ya mfumo
  db.system_logs.push({
    action: "ADD_RECORD",
    recordId: newRecord.id,
    timestamp: new Date().toISOString()
  });

  if (writeData(db)) {
    res.json({ success: true, message: "Record imehifadhiwa kwenye JSON successfully!", data: newRecord });
  } else {
    res.status(500).json({ success: false, error: "Imeshindwa kuhifadhi kwenye file la JSON." });
  }
});

// 3. Kufuta record (DELETE)
app.delete('/api/records/:id', (req, res) => {
  const recordId = req.params.id;
  const db = readData();
  
  const initialLength = db.records.length;
  db.records = db.records.filter(r => r.id !== recordId);

  if (db.records.length === initialLength) {
    return res.status(404).json({ success: false, error: "Record haijapatikana." });
  }

  db.system_logs.push({
    action: "DELETE_RECORD",
    recordId: recordId,
    timestamp: new Date().toISOString()
  });

  if (writeData(db)) {
    res.json({ success: true, message: "Record imefutwa kwenye JSON!" });
  } else {
    res.status(500).json({ success: false, error: "Imeshindwa kusasisha file la JSON baada ya kufuta." });
  }
});

// Route ya kurudisha index.html kama mtu akiingia kwenye root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route fallback ya kurasa za HTML zilizobaki automatic (Mfano: /records.html)
app.get('/:page.html', (req, res) => {
  const filePath = path.join(__dirname, `${req.params.page}.html`);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.redirect('/');
  }
});

// Anti-Crash Global Shields
process.on('uncaughtException', (err) => console.error('🔥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled Rejection:', reason));

// Kuanzisha Server (Inasoma Port ya Pterodactyl au 3000 ya default)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 JSON-Based Water Billing Server Active on Port ${PORT}`);
  console.log(`📂 Data inahifadhiwa kwenye: ${DATA_FILE}`);
});
