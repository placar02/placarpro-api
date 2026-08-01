const crypto = require('crypto');

const buckets = new Map();

function clientKey(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

function rateLimit({ windowMs = 60_000, max = 60, prefix = 'api', key = clientKey, skip } = {}) {
  return (req, res, next) => {
    if (skip?.(req)) return next();
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
      while (buckets.size > 12_000) buckets.delete(buckets.keys().next().value);
    }
    const bucketKey = `${prefix}:${key(req)}`;
    const current = buckets.get(bucketKey);
    if (!current || current.resetAt <= now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - 1)));
      return next();
    }
    current.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - current.count)));
    if (current.count > max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.', retryAfter });
    }
    return next();
  };
}

function slowDown({ windowMs = 60_000, delayAfter = 20, delayMs = 250, maxDelayMs = 2_000, prefix = 'slow' } = {}) {
  const middleware = rateLimit({
    windowMs,
    max: Number.MAX_SAFE_INTEGER,
    prefix,
    key(req) {
      const base = clientKey(req);
      const now = Date.now();
      const bucketKey = `${prefix}:counter:${base}`;
      const current = buckets.get(bucketKey);
      if (!current || current.resetAt <= now) buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      else current.count += 1;
      req.securityDelay = Math.min(maxDelayMs, Math.max(0, (Number(buckets.get(bucketKey)?.count) - delayAfter) * delayMs));
      return base;
    },
  });
  return (req, res, next) => middleware(req, res, (error) => {
    if (error) return next(error);
    return req.securityDelay ? setTimeout(next, req.securityDelay) : next();
  });
}

function requestTimeout(ms = 30_000) {
  return (req, res, next) => {
    res.setTimeout(ms, () => {
      if (!res.headersSent) res.status(503).json({ error: 'Tempo limite da requisicao excedido.' });
      else res.end();
    });
    next();
  };
}

module.exports = { clientKey, rateLimit, requestTimeout, slowDown };
