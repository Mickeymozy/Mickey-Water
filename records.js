// ================== UTILITY FUNCTIONS ==================
function showMessage(text, type = 'info', duration = 3000) {
  const msgDiv = document.getElementById('message');
  if (!msgDiv) return;
  
  msgDiv.textContent = text;
  msgDiv.style.background = type === 'error' 
    ? 'rgba(248,113,113,0.14)' 
    : type === 'success' 
      ? 'rgba(34,197,94,0.14)' 
      : 'rgba(56,189,248,0.12)';
  msgDiv.style.color = type === 'error' 
    ? '#fca5a5' 
    : type === 'success' 
      ? '#86efac' 
      : '#cffafe';
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

document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadRecords(1));
  }
  
  loadRecords(1);
});
