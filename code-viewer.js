// ================== CODE VIEWER - SERVER LOGS & EXAMPLES ==================

class CodeViewer {
  constructor() {
    this.logs = [];
    this.maxLogs = 100;
    this.initializeViewer();
  }

  initializeViewer() {
    this.logContainer = document.getElementById('codeLogsContainer');
    this.filterInput = document.getElementById('codeFilter');
    this.clearBtn = document.getElementById('clearLogs');
    this.exportBtn = document.getElementById('exportLogs');
    
    if (this.filterInput) {
      this.filterInput.addEventListener('input', () => this.filterLogs());
    }
    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', () => this.clearLogs());
    }
    if (this.exportBtn) {
      this.exportBtn.addEventListener('click', () => this.exportLogs());
    }
    
    this.loadDemoLogs();
  }

  log(message, type = 'info', code = null) {
    const timestamp = new Date().toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
    
    const logEntry = {
      id: Date.now(),
      timestamp,
      message,
      type,
      code,
      raw: `[${timestamp}] ${type.toUpperCase()}: ${message}`
    };
    
    this.logs.unshift(logEntry);
    
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }
    
    this.renderLogs();
  }

  loadDemoLogs() {
    // Server startup logs
    this.log('MongoDB Connected ✅', 'success', 'mongoose.connect(process.env.MONGODB_URI)');
    this.log('Passport Local Strategy initialized', 'info', "passport.use('local', new LocalStrategy(...))");
    this.log('Google OAuth Strategy configured', 'info', "passport.use('google', new GoogleStrategy(...))");
    this.log('Email service initialized', 'success', 'nodemailer configured');
    this.log('Server running on port 3000', 'success', 'app.listen(3000)');
    
    // API examples
    this.log('POST /signup - User registration endpoint', 'debug', `
app.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;
  const newUser = new User({ name, email, passwordHash: await bcrypt.hash(password, 10) });
  await newUser.save();
  res.json({ success: true, user: newUser });
});`);

    this.log('POST /local-login - Local authentication', 'debug', `
app.post('/local-login', (req, res, next) => {
  passport.authenticate('local', (err, user) => {
    if (!user) return res.status(401).json({ error: 'Invalid' });
    req.login(user, () => res.json({ success: true, user }));
  })(req, res, next);
});`);

    this.log('GET /get-records - Fetch user records', 'debug', `
app.get('/get-records', protect, async (req, res) => {
  const records = await Record.find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, records });
});`);

    this.log('POST /save-record - Create billing record', 'debug', `
app.post('/save-record', protect, async (req, res) => {
  const { curr, prev, name, phone, rate } = req.body;
  const usage = curr - prev;
  const total = usage * (rate || 2000);
  const record = new Record({ userId: req.user.id, name, phone, prev, curr, usage, total });
  await record.save();
  res.json({ success: true, record });
});`);
  }

  renderLogs() {
    if (!this.logContainer) return;

    this.logContainer.innerHTML = this.logs.map(log => `
      <div class="log-entry log-${log.type}">
        <div class="log-header">
          <span class="log-time">${log.timestamp}</span>
          <span class="log-type">${log.type.toUpperCase()}</span>
          <span class="log-message">${this.escapeHtml(log.message)}</span>
        </div>
        ${log.code ? `
          <div class="log-code">
            <pre><code>${this.highlightCode(log.code)}</code></pre>
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  filterLogs() {
    if (!this.filterInput || !this.logContainer) return;
    
    const filter = this.filterInput.value.toLowerCase();
    const entries = this.logContainer.querySelectorAll('.log-entry');
    
    entries.forEach(entry => {
      const message = entry.querySelector('.log-message').textContent.toLowerCase();
      const type = entry.querySelector('.log-type').textContent.toLowerCase();
      const match = message.includes(filter) || type.includes(filter);
      entry.style.display = match ? 'block' : 'none';
    });
  }

  highlightCode(code) {
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/(const|let|var|async|await|function|return|new|class)\b/g, '<span class="keyword">$1</span>')
      .replace(/(true|false|null|undefined)\b/g, '<span class="literal">$1</span>')
      .replace(/(['"`])(.*?)\1/g, '<span class="string">$&</span>')
      .replace(/\/\/.*$/gm, '<span class="comment">$&</span>')
      .replace(/(\d+)/g, '<span class="number">$1</span>');
  }

  escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  }

  clearLogs() {
    if (confirm('Clear all logs?')) {
      this.logs = [];
      this.renderLogs();
      this.log('Logs cleared', 'info');
    }
  }

  exportLogs() {
    const logText = this.logs.map(log => log.raw).reverse().join('\n');
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  window.codeViewer = new CodeViewer();
  console.log('✅ Code Viewer initialized');
});
