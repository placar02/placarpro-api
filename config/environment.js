const PLACEHOLDER_PATTERNS = [
  /^troque-/i,
  /^changeme$/i,
  /^seu-/i,
];

function isPlaceholder(value) {
  const text = String(value || '').trim();
  return !text || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text));
}

function validateEnvironment(env = process.env) {
  const errors = [];
  const production = env.NODE_ENV === 'production';

  if (isPlaceholder(env.JWT_SECRET) || String(env.JWT_SECRET || '').length < 32) {
    errors.push('JWT_SECRET deve ter pelo menos 32 caracteres e nao pode ser um valor de exemplo.');
  }

  if (production) {
    if (isPlaceholder(env.DATABASE_URL)) errors.push('DATABASE_URL e obrigatoria em producao.');
    if (isPlaceholder(env.FRONTEND_URL)) errors.push('FRONTEND_URL e obrigatoria em producao.');
    if (isPlaceholder(env.CORS_ORIGINS)) errors.push('CORS_ORIGINS e obrigatoria em producao.');
    if (env.MERCADOPAGO_ACCESS_TOKEN && isPlaceholder(env.MERCADOPAGO_WEBHOOK_SECRET)) {
      errors.push('MERCADOPAGO_WEBHOOK_SECRET e obrigatoria quando pagamentos estao ativos.');
    }
    if (env.AUTH_COOKIE_SAME_SITE === 'none' && env.FRONTEND_URL && !String(env.FRONTEND_URL).startsWith('https://')) {
      errors.push('FRONTEND_URL deve usar HTTPS quando AUTH_COOKIE_SAME_SITE=none.');
    }
    if (env.ALLOW_PAYMENT_TEST_APPROVAL === 'true' || env.EXPOSE_PASSWORD_RESET_TOKEN === 'true') {
      errors.push('Recursos exclusivos de teste nao podem estar ativos em producao.');
    }
  }

  if (errors.length) {
    const error = new Error(`Configuracao de ambiente invalida:\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_ENVIRONMENT';
    throw error;
  }
}

function getJwtSecret() {
  return String(process.env.JWT_SECRET || '');
}

module.exports = { getJwtSecret, isPlaceholder, validateEnvironment };
