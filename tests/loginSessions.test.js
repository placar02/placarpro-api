const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('login cria uma nova sessao sem limitar acessos simultaneos', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const loginStart = server.indexOf("app.post('/api/auth/login'");
  const loginEnd = server.indexOf("app.get('/api/dashboard'", loginStart);
  const loginRoute = server.slice(loginStart, loginEnd);

  assert.ok(loginStart >= 0 && loginEnd > loginStart);
  assert.match(loginRoute, /INSERT INTO user_sessions/);
  assert.match(loginRoute, /expires_at <= CURRENT_TIMESTAMP/);
  assert.doesNotMatch(loginRoute, /max_accesses|maxAccesses|activeSessions|acesso\(s\) simultaneo/);
});
