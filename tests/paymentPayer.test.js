const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMercadoPagoPixPayer, resolveMercadoPagoPayerEmail } = require('../services/paymentPayer');

test('normaliza e usa o email da conta autenticada como fonte principal', () => {
  assert.equal(resolveMercadoPagoPayerEmail({
    authenticatedEmail: '  Usuario@Email.COM  ',
    submittedEmail: 'outro@email.com',
  }), 'usuario@email.com');
});

test('constroi o objeto payer do PIX com email autenticado valido', () => {
  assert.deepEqual(buildMercadoPagoPixPayer({
    authenticatedEmail: ' Usuario@Email.com ',
    sessionEmail: 'sessao@email.com',
    firstName: ' Usuario ',
  }), {
    email: 'usuario@email.com',
    first_name: 'Usuario',
  });
});

test('usa email submetido somente como fallback para conta legada invalida', () => {
  assert.equal(resolveMercadoPagoPayerEmail({
    authenticatedEmail: 'email-invalido',
    submittedEmail: 'cartao@email.com',
  }), 'cartao@email.com');
});

test('usa o email assinado na sessao antes de aceitar o email submetido', () => {
  assert.equal(resolveMercadoPagoPayerEmail({
    authenticatedEmail: 'email-invalido',
    sessionEmail: 'sessao@email.com',
    submittedEmail: 'formulario@email.com',
  }), 'sessao@email.com');
});

test('usa comprador de teste valido quando o Mercado Pago esta em teste', () => {
  assert.equal(resolveMercadoPagoPayerEmail({
    authenticatedEmail: 'usuario@email.com',
    testBuyerEmail: ' TEST_USER_123@testuser.com ',
    testMode: true,
  }), 'test_user_123@testuser.com');
});

test('rejeita comprador de teste mal configurado antes de chamar o Mercado Pago', () => {
  assert.throws(() => resolveMercadoPagoPayerEmail({
    authenticatedEmail: 'usuario@email.com',
    testBuyerEmail: 'invalido',
    testMode: true,
  }), (error) => error.code === 'INVALID_PAYER_EMAIL' && error.statusCode === 500);
});

test('rejeita payload sem qualquer email valido antes da chamada externa', () => {
  assert.throws(() => resolveMercadoPagoPayerEmail({
    authenticatedEmail: 'invalido',
  }), (error) => error.code === 'INVALID_PAYER_EMAIL' && error.statusCode === 422);
});
