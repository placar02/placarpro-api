const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRole, isActiveAccount, isAdminAccount } = require('../middlewares/accessPolicy');
const { validate } = require('../validators/adminValidators');

test('RBAC permite somente conta admin ativa', () => {
  assert.equal(isAdminAccount({ id: 1, role: 'admin', status: 'active' }), true);
  assert.equal(isAdminAccount({ id: 2, role: 'premium', status: 'active' }), false);
  assert.equal(isAdminAccount({ id: 3, role: 'free', status: 'active' }), false);
  assert.equal(isAdminAccount({ id: 4, role: 'admin', status: 'blocked' }), false);
});

test('RBAC converte plano legado sem conceder admin', () => {
  assert.equal(normalizeRole({ plano: 'premium' }), 'premium');
  assert.equal(normalizeRole({ plano: 'basico' }), 'free');
  assert.equal(isActiveAccount({ id: 1 }), true);
});

test('validadores rejeitam payloads perigosos ou incompletos', () => {
  assert.ok(validate('user', { role: 'root' }, true).length > 0);
  assert.ok(validate('plan', { name: '', price_cents: -1 }).length > 0);
  assert.ok(validate('entry', { league: 'A', market: 'B', odd: 1 }).length > 0);
  assert.ok(validate('news', { title: '', content: '' }).length > 0);
});

test('validadores aceitam CRUDs administrativos válidos', () => {
  assert.deepEqual(validate('plan', { name: 'Premium', price_cents: 4990, benefits: [], color: '#00E676' }), []);
  assert.deepEqual(validate('entry', { league: 'Série A', market: 'Mais de 2.5 gols', odd: 1.75, confidence: 80 }), []);
  assert.deepEqual(validate('news', { title: 'Rodada aberta', content: 'Conteúdo da notícia' }), []);
});
