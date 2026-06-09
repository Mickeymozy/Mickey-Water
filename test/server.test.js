const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ORIGINAL_PORT = process.env.PORT;

function startServer() {
  process.env.PORT = '3101';
  const app = require('../server');
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(3101, () => resolve(server));
  });
}

test('login and signup pages are present for the full auth system', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'login.html')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'signup.html')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'reset.html')), true);
});

test('health endpoint is available for the full system', async () => {
  let server;

  try {
    server = await startServer();
    const response = await fetch('http://127.0.0.1:3101/api/health');

    assert.equal(response.status, 200, 'health endpoint should be available');

    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.message, 'string');
  } finally {
    if (server) server.close();
    if (ORIGINAL_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = ORIGINAL_PORT;
    delete require.cache[require.resolve('../server')];
  }
});

test('signup endpoint accepts a new user account', async () => {
  let server;

  try {
    server = await startServer();
    const response = await fetch('http://127.0.0.1:3101/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Regression User', email: 'regression@example.com', password: 'StrongPass123!' })
    });

    assert.equal(response.status, 200, 'signup should succeed');
    const data = await response.json();
    assert.equal(data.success, true);
    assert.equal(data.user.email, 'regression@example.com');
  } finally {
    if (server) server.close();
    if (ORIGINAL_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = ORIGINAL_PORT;
    delete require.cache[require.resolve('../server')];
  }
});

test('login endpoint accepts the demo user', async () => {
  let server;

  try {
    server = await startServer();
    const response = await fetch('http://127.0.0.1:3101/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@waterbilling.com', password: 'Demo123!' })
    });

    assert.equal(response.status, 200, 'demo login should succeed');
    const data = await response.json();
    assert.equal(data.success, true);
    assert.equal(data.user.email, 'demo@waterbilling.com');
  } finally {
    if (server) server.close();
    if (ORIGINAL_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = ORIGINAL_PORT;
    delete require.cache[require.resolve('../server')];
  }
});


