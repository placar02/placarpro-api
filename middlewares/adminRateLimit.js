const buckets = new Map();

function adminRateLimit({ windowMs = 60000, max = 120 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.user?.id || req.ip}:${req.method}:${req.baseUrl}`;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      return res.status(429).json({ error: 'Muitas operacoes administrativas. Tente novamente em instantes.' });
    }
    return next();
  };
}

module.exports = { adminRateLimit };
