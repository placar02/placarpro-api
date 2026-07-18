const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { get, run } = require('../db');
const { getJwtSecret } = require('../config/environment');
const { isAdminAccount } = require('./accessPolicy');

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'placarpro_session';
const SESSION_HOURS = Math.max(1, Number(process.env.AUTH_SESSION_HOURS || 24));

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function csrfForSession(sessionId) {
  return crypto.createHmac('sha256', getJwtSecret()).update(`csrf:${sessionId}`).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieOptions() {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: process.env.AUTH_COOKIE_SAME_SITE || (production ? 'none' : 'lax'),
    path: '/',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  };
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearSessionCookie(res) {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(COOKIE_NAME, options);
}

function issueSessionToken(user, sessionId) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, sid: sessionId }, getJwtSecret(), {
    expiresIn: `${SESSION_HOURS}h`,
  });
}

async function authenticateToken(req, res, next) {
  const header = String(req.headers.authorization || '');
  const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const cookieToken = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const token = bearerToken || cookieToken;
  if (!token) return res.status(401).json({ error: 'Autenticacao necessaria.' });

  try {
    const claims = jwt.verify(token, getJwtSecret());
    const account = await get('SELECT id, email, role, plano, status FROM users WHERE id = ?', [claims.id]);
    if (!account || account.status === 'blocked') return res.status(403).json({ error: 'Acesso negado.' });

    if (claims.sid) {
      const session = await get('SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND revoked = FALSE AND expires_at > CURRENT_TIMESTAMP', [claims.sid, claims.id]);
      if (!session) return res.status(403).json({ error: 'Sessao expirada ou encerrada.' });

      const unsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (cookieToken && !bearerToken && unsafeMethod && !safeEqual(req.headers['x-csrf-token'], csrfForSession(claims.sid))) {
        return res.status(403).json({ error: 'Token CSRF invalido.', code: 'CSRF_INVALID' });
      }

      await run('UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [claims.sid]);
    }

    req.user = { ...claims, role: account.role || (account.plano === 'premium' ? 'premium' : 'free') };
    req.authSource = bearerToken ? 'bearer' : 'cookie';
    return next();
  } catch (error) {
    if (error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError') return next(error);
    return res.status(403).json({ error: 'Token invalido ou expirado.' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await get('SELECT id, role, status FROM users WHERE id = ?', [req.user.id]);
    if (!isAdminAccount(user)) {
      return res.status(403).json({ error: 'Acesso negado.', code: 'ADMIN_REQUIRED' });
    }
    req.admin = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  authenticateToken,
  clearSessionCookie,
  csrfForSession,
  issueSessionToken,
  requireAdmin,
  setSessionCookie,
};
