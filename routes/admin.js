const express = require('express');
const controller = require('../controllers/adminController');
const { authenticateToken, requireAdmin } = require('../middlewares/auth');
const { adminRateLimit } = require('../middlewares/adminRateLimit');
const { validateBody } = require('../validators/adminValidators');

const router = express.Router();
router.use(authenticateToken, requireAdmin, adminRateLimit());
router.get('/dashboard', controller.dashboard);
router.get('/users', controller.users);
router.get('/users/:id', controller.user);
router.put('/users/:id', validateBody('user', true), controller.updateUser);
router.patch('/users/:id', validateBody('user', true), controller.updateUser);
router.patch('/users/:id/password', adminRateLimit({ windowMs: 900000, max: 10 }), controller.changePassword);
router.delete('/users/:id', adminRateLimit({ windowMs: 900000, max: 20 }), controller.deleteUser);

const plans = controller.resource('plans');
router.get('/plans', plans.list);
router.post('/plans', validateBody('plan'), plans.create);
router.put('/plans/:id', validateBody('plan', true), plans.update);
router.patch('/plans/:id', validateBody('plan', true), plans.update);
router.delete('/plans/:id', plans.remove);

router.get('/payments', controller.payments);
router.put('/payments', controller.updatePayments);
const coupons = controller.resource('coupons');
router.post('/payments/coupons', coupons.create);
router.put('/payments/coupons/:id', coupons.update);
router.delete('/payments/coupons/:id', coupons.remove);

router.get('/settings', controller.settings);
router.put('/settings', validateBody('settings', true), controller.updateSettings);

for (const [path, table, validator] of [['entries', 'entries', 'entry'], ['news', 'news', 'news']]) {
  const handlers = controller.resource(table);
  router.get(`/${path}`, handlers.list);
  router.post(`/${path}`, validateBody(validator), handlers.create);
  router.put(`/${path}/:id`, validateBody(validator, true), handlers.update);
  router.patch(`/${path}/:id`, validateBody(validator, true), handlers.update);
  router.delete(`/${path}/:id`, handlers.remove);
}

router.get('/audit-logs', controller.auditLogs);
router.use((error, _req, res, _next) => {
  console.error('Erro administrativo:', error);
  if (error.code === '23505') return res.status(409).json({ error: 'Ja existe um registro com esses dados.' });
  if (error.code === '23503') return res.status(409).json({ error: 'O registro esta em uso e nao pode ser removido.' });
  return res.status(500).json({ error: 'Erro interno ao processar operacao administrativa.' });
});

module.exports = router;
