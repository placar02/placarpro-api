const { rateLimit } = require('./security');

function adminRateLimit({ windowMs = 60000, max = 120 } = {}) {
  return rateLimit({ windowMs, max, prefix: 'admin', key: (req) => `${req.user?.id || req.ip}:${req.method}:${req.baseUrl}` });
}

module.exports = { adminRateLimit };
