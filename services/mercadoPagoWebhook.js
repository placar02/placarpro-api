const crypto = require('crypto');

function parseSignature(signature = '') {
  return String(signature).split(',').reduce((parts, item) => {
    const [key, ...value] = item.trim().split('=');
    if (key && value.length) parts[key] = value.join('=');
    return parts;
  }, {});
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]+$/i.test(String(left || '')) || !/^[a-f0-9]+$/i.test(String(right || ''))) return false;
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyMercadoPagoSignature({ dataId, requestId, signature, secret, now = Date.now(), toleranceSeconds = 300 }) {
  if (!secret || !signature) return { valid: false, reason: 'missing_signature' };
  const { ts, v1 } = parseSignature(signature);
  if (!ts || !v1) return { valid: false, reason: 'invalid_signature_format' };

  const timestampMs = Number(ts) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > toleranceSeconds * 1000) {
    return { valid: false, reason: 'expired_signature' };
  }

  const id = String(dataId || '').toLowerCase();
  const manifest = `${id ? `id:${id};` : ''}${requestId ? `request-id:${requestId};` : ''}ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return { valid: timingSafeHexEqual(expected, v1), reason: timingSafeHexEqual(expected, v1) ? null : 'signature_mismatch' };
}

module.exports = { parseSignature, verifyMercadoPagoSignature };
