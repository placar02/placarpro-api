const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentBelongsToSession } = require('../services/paymentSession');

test('vincula pagamento somente ao checkout e external reference da sessao', () => {
  const session = { checkout_id: 'pay-123', external_id: 'premium-7-123' };
  assert.equal(paymentBelongsToSession({ id: 'pay-123', external_reference: 'premium-7-123' }, session), true);
  assert.equal(paymentBelongsToSession({ id: 'pay-other', external_reference: 'premium-7-123' }, session), false);
  assert.equal(paymentBelongsToSession({ id: 'pay-123', external_reference: 'premium-8-999' }, session), false);
});

test('aceita nomes alternativos documentados sem aceitar dados ausentes', () => {
  const session = { checkout_id: '42', external_id: 'ext-42' };
  assert.equal(paymentBelongsToSession({ payment_id: 42, metadata: { external_id: 'ext-42' } }, session), true);
  assert.equal(paymentBelongsToSession({}, session), false);
  assert.equal(paymentBelongsToSession(null, session), false);
});
