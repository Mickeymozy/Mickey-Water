// ================== UTILITY FUNCTIONS ==================
function showMessage(text, type = 'info', duration = 3000) {
  const msgDiv = document.getElementById('message');
  if (!msgDiv) return;
  
  msgDiv.textContent = text;
  msgDiv.className = `message ${type}`;
  msgDiv.style.display = 'block';
  
  if (duration > 0) {
    setTimeout(() => { msgDiv.style.display = 'none'; }, duration);
  }
}

async function authFetch(url, options = {}) {
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed: ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.error('Fetch error:', err);
    throw err;
  }
}

function logout() {
  fetch('/logout', { credentials: 'same-origin', method: 'GET' }).finally(() => {
    window.location.href = '/login.html';
  });
}

// ================== TAB MANAGEMENT ==================
function switchTab(tabName) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  
  // Deactivate all buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Show selected tab
  const selectedTab = document.getElementById(tabName);
  if (selectedTab) {
    selectedTab.classList.add('active');
  }
  
  // Activate corresponding button
  const selectedBtn = document.querySelector(`[data-tab="${tabName}"]`);
  if (selectedBtn) {
    selectedBtn.classList.add('active');
  }
}

// ================== FORM CALCULATIONS ==================
function calculateUsageAndTotal() {
  const prevReading = parseFloat(document.getElementById('previousReading').value) || 0;
  const currReading = parseFloat(document.getElementById('currentReading').value) || 0;
  const rate = parseFloat(document.getElementById('ratePerUnit').value) || 2000;
  const fixedCharge = parseFloat(document.getElementById('fixedCharge').value) || 0;
  
  // Calculate usage (current - previous)
  const usage = Math.max(0, currReading - prevReading);
  
  // Calculate total ((usage × rate) + fixed charge)
  const total = (usage * rate) + fixedCharge;
  
  // Display calculations
  const usageDisplay = document.getElementById('calculatedUsage');
  const totalDisplay = document.getElementById('calculatedTotal');
  
  if (usageDisplay) {
    usageDisplay.textContent = `${usage.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m³`;
  }
  
  if (totalDisplay) {
    totalDisplay.textContent = `TZS ${Math.round(total).toLocaleString('en-US')}`;
  }
}

function resetAddRecordForm() {
  const form = document.getElementById('addRecordForm');
  if (form) {
    form.reset();
    // Reset defaults
    document.getElementById('ratePerUnit').value = '2000';
    document.getElementById('fixedCharge').value = '0';
    calculateUsageAndTotal();
    showMessage('Form cleared', 'success', 1500);
  }
}

// ================== FORM SUBMISSION ==================
async function submitAddRecord(event) {
  event.preventDefault();
  
  // Collect form data
  const name = document.getElementById('customerName').value.trim();
  const phone = document.getElementById('phoneNumber').value.trim();
  const prevReading = parseFloat(document.getElementById('previousReading').value);
  const currReading = parseFloat(document.getElementById('currentReading').value);
  const rate = parseFloat(document.getElementById('ratePerUnit').value) || 2000;
  const fixedCharge = parseFloat(document.getElementById('fixedCharge').value) || 0;
  
  // Validation
  if (!name) {
    showMessage('Customer name is required', 'error');
    return;
  }
  
  if (isNaN(prevReading) || prevReading < 0) {
    showMessage('Previous reading must be a valid number', 'error');
    return;
  }
  
  if (isNaN(currReading) || currReading < 0) {
    showMessage('Current reading must be a valid number', 'error');
    return;
  }
  
  if (currReading < prevReading) {
    showMessage('Current reading cannot be less than previous reading', 'error');
    return;
  }
  
  // Calculate usage and total
  const usage = currReading - prevReading;
  const total = (usage * rate) + fixedCharge;
  
  try {
    showMessage('Saving record...', 'info', -1);
    
    const response = await authFetch('/save-record', {
      method: 'POST',
      body: JSON.stringify({
        name,
        phone: phone || null,
        prev: prevReading,
        curr: currReading,
        usage,
        total: Math.round(total)
      })
    });
    
    if (!response.success) {
      showMessage(response.error || 'Failed to save record', 'error');
      return;
    }
    
    showMessage('Record saved successfully!', 'success', 2000);
    
    // Reset form
    resetAddRecordForm();
    
    // Reload records list
    await loadRecords(1);
    
    // Switch back to View Records tab
    setTimeout(() => switchTab('view-records'), 500);
    
  } catch (err) {
    console.error('Error saving record:', err);
    showMessage(err.message || 'Error saving record', 'error');
  }
}

// ================== RECORDS MANAGEMENT ==================
let currentPage = 1;
const recordsPerPage = 20;
let totalRecords = 0;
let allRecordsData = [];

async function loadRecords(page = 1) {
  try {
    currentPage = page;
    showMessage('Loading records...', 'info', -1);
    
    const data = await authFetch(`/get-records?page=${page}&limit=${recordsPerPage}`);
    
    if (!data.success) {
      showMessage('Failed to load records', 'error');
      return;
    }
    
    const { records, pagination } = data;
    totalRecords = pagination.total;
    allRecordsData = records;
    
    renderRecordsTable(records);
    updateSummaryMetrics(records);
    showMessage(`Loaded ${records.length} records`, 'success', 2000);
  } catch (err) {
    console.error('Error loading records:', err);
    showMessage(err.message || 'Error loading records', 'error');
  }
}

function renderRecordsTable(records) {
  const tbody = document.getElementById('recordsBody');
  if (!tbody) return;
  
  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No records found</td></tr>';
    return;
  }
  
  tbody.innerHTML = records.map(record => {
    const date = new Date(record.createdAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    });
    
    return `
      <tr>
        <td>${date}</td>
        <td>${escapeHtml(record.name || '-')}</td>
        <td>${escapeHtml(record.phone || '-')}</td>
        <td>${record.prev ?? '-'}</td>
        <td>${record.curr ?? '-'}</td>
        <td>${record.usage ?? '-'}</td>
        <td>TZS ${(record.total ?? 0).toLocaleString('en-US')}</td>
      </tr>
    `;
  }).join('');
}

function updateSummaryMetrics(records) {
  const recordCount = totalRecords || records.length;
  const totalUsage = records.reduce((sum, r) => sum + (r.usage || 0), 0);
  const totalAmount = records.reduce((sum, r) => sum + (r.total || 0), 0);
  
  const recordCountEl = document.getElementById('recordCount');
  const totalUsageEl = document.getElementById('totalUsage');
  const totalAmountEl = document.getElementById('totalAmount');
  
  if (recordCountEl) recordCountEl.textContent = recordCount;
  if (totalUsageEl) totalUsageEl.textContent = totalUsage.toLocaleString('en-US');
  if (totalAmountEl) totalAmountEl.textContent = `TZS ${totalAmount.toLocaleString('en-US')}`;
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// ================== INITIALIZE ==================
window.logout = logout;
window.switchTab = switchTab;
window.resetAddRecordForm = resetAddRecordForm;

document.addEventListener('DOMContentLoaded', () => {
  // Refresh button
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadRecords(1));
  }
  
  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      switchTab(e.target.dataset.tab);
    });
  });
  
  // Form submission
  const addRecordForm = document.getElementById('addRecordForm');
  if (addRecordForm) {
    addRecordForm.addEventListener('submit', submitAddRecord);
  }
  
  // Real-time calculation on input changes
  const calcInputs = ['previousReading', 'currentReading', 'ratePerUnit', 'fixedCharge'];
  calcInputs.forEach(inputId => {
    const input = document.getElementById(inputId);
    if (input) {
      input.addEventListener('input', calculateUsageAndTotal);
    }
  });
  
  // Check URL parameters for ?action=add
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'add') {
    switchTab('add-record');
  }
  
  // Load records
  loadRecords(1);
});
