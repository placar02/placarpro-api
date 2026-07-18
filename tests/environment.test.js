const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvironment } = require('../config/environment');

const validProduction = {
  NODE_ENV: 'production',
  JWT_SECRET: 'a'.repeat(64),
  DATABASE_URL: 'postgresql://user:pass@host:5432/database',
  FRONTEND_URL: 'https://placarpro.example',
  CORS_ORIGINS: 'https://placarpro.example',
};

test('aceita ambiente de producao completo', () => {
  assert.doesNotThrow(() => validateEnvironment(validProduction));
});

test('rejeita segredo JWT fraco ou de exemplo', () => {
  assert.throws(
    () => validateEnvironment({ ...validProduction, JWT_SECRET: 'troque-por-um-segredo-grande' }),
    /JWT_SECRET/
  );
});

test('exige segredo do webhook quando Mercado Pago esta ativo', () => {
  assert.throws(
    () => validateEnvironment({ ...validProduction, MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-real-token' }),
    /MERCADOPAGO_WEBHOOK_SECRET/
  );
});
