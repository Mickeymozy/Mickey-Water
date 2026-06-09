const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_PORT = process.env.PORT;

function startServer() {
  process.env.PORT = '3101';
  const app = require('../server');
  return new Promise((resolve) => {
    const server = app.listen(3101, () => resolve(server));
  });
}

test('offline fallback login accepts the demo user', async () => {
  let server;

  try {
    server = await startServer();
    const response = await fetch('https://water-billing-rho.vercel.app/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mickidadyhamza@gmail.com', password: 'MICKEY24@' })
    });

    assert.equal(response.status, 200, 'demo user login should succeed even when MongoDB is unavailable');

    const data = await response.json();
    assert.equal(data.success, true);
    assert.equal(data.user.role, 'user');
    assert.equal(data.user.email, 'mickidadyhamza@gmail.com');
  } finally {
    if (server) server.close();
    if (ORIGINAL_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = ORIGINAL_PORT;
    delete require.cache[require.resolve('../server')];
  }
});
