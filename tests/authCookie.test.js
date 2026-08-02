const test = require('node:test');
const assert = require('node:assert/strict');
const { cookieOptions } = require('../middlewares/auth');

test('cookie de producao e first-party, seguro e compativel com Safari/iOS', () => {
  const options = cookieOptions({ NODE_ENV: 'production', AUTH_COOKIE_SAME_SITE: 'lax' });

  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.path, '/');
  assert.equal(options.priority, 'high');
  assert.equal('domain' in options, false);
});

test('cookie local nao exige HTTPS e valores invalidos recaem para lax', () => {
  const options = cookieOptions({ NODE_ENV: 'development', AUTH_COOKIE_SAME_SITE: 'invalido' });

  assert.equal(options.secure, false);
  assert.equal(options.sameSite, 'lax');
});
