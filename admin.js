function showNotification(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = [
    'position: fixed',
    'top: 20px',
    'right: 20px',
    'padding: 14px 18px',
    'border-radius: 14px',
    'color: white',
    'font-weight: 700',
    'font-family: system-ui, sans-serif',
    'z-index: 10000',
    'max-width: 320px',
    'box-shadow: 0 16px 50px rgba(0,0,0,0.28)',
    `background: ${type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#2563eb'}`
  ].join(';');

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.style.opacity = '1');
  setTimeout(() => toast.remove(), duration);
}

async function authFetch(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function logout() {
  fetch('/logout', { credentials: 'same-origin', method: 'GET' }).finally(() => {
    window.location.href = '/login.html';
  });
}

window.logout = logout;

async function loadAdmin() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) {
      window.location.href = '/login.html';
      return;
    }

    const data = await res.json();
    if (!data?.user?.email) {
      window.location.href = '/login.html';
      return;
    }

    await refreshStats();
  } catch (err) {
    console.error(err);
    window.location.href = '/login.html';
  }
}

async function refreshStats() {
  try {
    const [users, records, resets] = await Promise.all([
      authFetch('/api/users/count'),
      authFetch('/api/records/count'),
      authFetch('/api/password-reset-requests')
    ]);

    document.getElementById('usersCount').textContent = users.count ?? 0;
    document.getElementById('recordsCount').textContent = records.count ?? 0;
    document.getElementById('resetCount').textContent = Array.isArray(resets.requests) ? resets.requests.length : 0;
    showStatus('Dashboard updated', 'success');
  } catch (err) {
    console.error(err);
    const msg = err.message || 'Unable to load stats';
    if (msg.toLowerCase().includes('unauthorized') || msg.includes('403')) {
      window.location.href = '/login.html';
      return;
    }
    showStatus(msg, 'error');
  }
}

function showStatus(message, type = 'info') {
  const el = document.getElementById('statusMessage');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  el.style.background = type === 'error' ? 'rgba(248,113,113,0.14)' : 'rgba(56,189,248,0.14)';
  el.style.color = type === 'error' ? '#b91c1c' : '#0f172a';
}

async function submitNotificationForm(event) {
  event.preventDefault();
  const button = document.getElementById('sendBtn');
  const title = document.getElementById('notificationTitle').value.trim();
  const body = document.getElementById('notificationBody').value.trim();
  const url = document.getElementById('notificationUrl').value.trim() || '/botweb.html';

  if (!title || !body) {
    showStatus('Title and message are required', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'Sending...';

  try {
    const result = await authFetch('/api/send-notification', {
      method: 'POST',
      body: JSON.stringify({ title, body, url })
    });
    showStatus(result.message || 'Notification sent', 'success');
    document.getElementById('notificationForm').reset();
  } catch (err) {
    showStatus(err.message || 'Failed to send notification', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Send notification';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAdmin();
  const form = document.getElementById('notificationForm');
  if (form) {
    form.addEventListener('submit', submitNotificationForm);
  }
});

