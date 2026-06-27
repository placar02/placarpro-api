const ADMIN_ROLES = new Set(['admin']);
const VALID_ROLES = new Set(['admin', 'premium', 'free']);

const normalizeRole = (user = {}) => user.role || (user.plano === 'premium' ? 'premium' : 'free');
const isActiveAccount = (user = {}) => Boolean(user.id) && user.status !== 'blocked';
const isAdminAccount = (user = {}) => isActiveAccount(user) && ADMIN_ROLES.has(normalizeRole(user));

module.exports = { VALID_ROLES, normalizeRole, isActiveAccount, isAdminAccount };
