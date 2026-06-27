const jwt = require('jsonwebtoken');
const { get } = require('../db');
const { isAdminAccount } = require('./accessPolicy');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-betleverage-key-2026';

function authenticateToken(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Autenticacao necessaria.' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_error) {
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

module.exports = { authenticateToken, requireAdmin };
