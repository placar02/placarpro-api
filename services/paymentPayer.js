const { validEmail } = require('../validators/publicValidators');

function payerEmailError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = 'INVALID_PAYER_EMAIL';
  return error;
}

function resolveMercadoPagoPayerEmail({
  authenticatedEmail,
  sessionEmail,
  submittedEmail,
  testBuyerEmail,
  testMode = false,
} = {}) {
  const configuredTestEmail = String(testBuyerEmail || '').trim();
  if (testMode && configuredTestEmail) {
    const normalizedTestEmail = validEmail(configuredTestEmail);
    if (!normalizedTestEmail) {
      throw payerEmailError('MERCADOPAGO_TEST_BUYER_EMAIL possui um email invalido.', 500);
    }
    return normalizedTestEmail;
  }

  // A conta autenticada é a fonte principal. O email submetido existe apenas
  // como fallback para compatibilidade do formulário de cartão.
  const normalizedAuthenticatedEmail = validEmail(authenticatedEmail);
  if (normalizedAuthenticatedEmail) return normalizedAuthenticatedEmail;

  const normalizedSessionEmail = validEmail(sessionEmail);
  if (normalizedSessionEmail) return normalizedSessionEmail;

  const normalizedSubmittedEmail = validEmail(submittedEmail);
  if (normalizedSubmittedEmail) return normalizedSubmittedEmail;

  throw payerEmailError('O email da conta e invalido. Atualize seu cadastro antes de pagar.', 422);
}

function buildMercadoPagoPixPayer({ firstName, ...emailSources } = {}) {
  const payer = { email: resolveMercadoPagoPayerEmail(emailSources) };
  const normalizedFirstName = String(firstName || '').trim();
  if (normalizedFirstName) payer.first_name = normalizedFirstName;
  return payer;
}

module.exports = { buildMercadoPagoPixPayer, resolveMercadoPagoPayerEmail };
