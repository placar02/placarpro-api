const crypto = require('crypto');
const SENSITIVE = /password|senha|authorization|cookie|jwt|token|secret|api[_-]?key|cpf|card|cartao|identification|raw_payload/i;

function redact(value, key = '', depth = 0) {
  if (SENSITIVE.test(key)) return '[REDACTED]';
  if (depth > 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, depth + 1)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]').slice(0, 4000);
  return value;
}

function anonymizeIp(ip) {
  if (!ip) return null;
  return crypto.createHmac('sha256', process.env.LOG_PSEUDONYM_KEY || process.env.JWT_SECRET || 'development-only')
    .update(String(ip)).digest('hex').slice(0, 24);
}

function write(level, message, context = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redact(context),
  };
  const output = JSON.stringify(payload);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

module.exports = {
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
  anonymizeIp,
  redact,
};
