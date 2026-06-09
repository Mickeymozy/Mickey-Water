const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ORIGINAL_PORT = process.env.PORT;

function startServer() {
  process.env.PORT = '3101';
  const app = require('../server');
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(3101, () => resolve(server));
  });
}

test('offline fallback login accepts the demo user', async () => {
  let server;

  try {
    server = await startServer();
    const response = await fetch('http://127.0.0.1:3101/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@waterbilling.com', password: 'Demo123!' })
    });

    assert.equal(response.status, 200, 'demo user login should succeed even when MongoDB is unavailable');

    const data = await response.json();
    assert.equal(data.success, true);
    assert.equal(data.user.role, 'user');
    assert.equal(data.user.email, 'demo@waterbilling.com');
  } finally {
    if (server) server.close();
    if (ORIGINAL_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = ORIGINAL_PORT;
    delete require.cache[require.resolve('../server')];
  }
});
