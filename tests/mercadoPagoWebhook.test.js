const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyMercadoPagoSignature } = require('../services/mercadoPagoWebhook');

const secret = 'webhook-secret-for-tests';
const dataId = '123456';
const requestId = 'request-abc';
const timestamp = 1784300000;
const now = timestamp * 1000;
const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
const digest = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

test('aceita assinatura oficial valida do Mercado Pago', () => {
  const result = verifyMercadoPagoSignature({
    dataId,
    requestId,
    signature: `ts=${timestamp},v1=${digest}`,
    secret,
    now,
  });
  assert.equal(result.valid, true);
});

test('rejeita assinatura adulterada', () => {
  const result = verifyMercadoPagoSignature({
    dataId: 'outro-pagamento',
    requestId,
    signature: `ts=${timestamp},v1=${digest}`,
    secret,
    now,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('rejeita replay fora da janela permitida', () => {
  const result = verifyMercadoPagoSignature({
    dataId,
    requestId,
    signature: `ts=${timestamp},v1=${digest}`,
    secret,
    now: now + 301000,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired_signature');
});
