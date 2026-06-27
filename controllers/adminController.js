const bcrypt = require('bcrypt');
const { run, get } = require('../db');
const service = require('../services/adminService');
const { audit } = require('../services/auditService');

const safe = (handler) => async (req, res, next) => {
  try { await handler(req, res); } catch (error) { next(error); }
};

const dashboard = safe(async (_req, res) => res.json(await service.dashboard()));
const users = safe(async (req, res) => res.json(await service.listUsers(req.query)));
const user = safe(async (req, res) => {
  const item = await service.getUser(req.params.id);
  if (!item) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  return res.json(item);
});
const updateUser = safe(async (req, res) => {
  const before = await service.getUser(req.params.id);
  if (!before) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  if (Number(req.params.id) === Number(req.user.id) && ((req.body.role && req.body.role !== 'admin') || req.body.status === 'blocked')) {
    return res.status(409).json({ error: 'Voce nao pode remover ou bloquear o proprio acesso administrativo.' });
  }
  const after = await service.updateUser(req.params.id, req.body);
  await audit(req, 'user.update', 'user', req.params.id, before, after);
  return res.json(after);
});
const deleteUser = safe(async (req, res) => {
  if (Number(req.params.id) === Number(req.user.id)) return res.status(409).json({ error: 'Voce nao pode excluir a propria conta.' });
  const before = await service.getUser(req.params.id);
  if (!before) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  await audit(req, 'user.delete', 'user', req.params.id, before, null);
  await service.deleteUser(req.params.id);
  return res.status(204).end();
});
const changePassword = safe(async (req, res) => {
  if (String(req.body.password || '').length < 8) return res.status(422).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
  const userExists = await get('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!userExists) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const password = await bcrypt.hash(req.body.password, 10);
  await run('UPDATE users SET senha = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [password, req.params.id]);
  await audit(req, 'user.password_change', 'user', req.params.id, null, { password_changed: true });
  return res.json({ success: true });
});

function resource(table) {
  return {
    list: safe(async (req, res) => res.json(await service.listResource(table, req.query))),
    create: safe(async (req, res) => {
      const payload = { ...req.body };
      if (['entries', 'news'].includes(table)) payload.created_by = req.user.id;
      const item = await service.saveResource(table, payload);
      await audit(req, `${table}.create`, table, item.id, null, item);
      res.status(201).json(item);
    }),
    update: safe(async (req, res) => {
      const before = await get(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
      if (!before) return res.status(404).json({ error: 'Registro nao encontrado.' });
      const item = await service.saveResource(table, req.body, req.params.id);
      await audit(req, `${table}.update`, table, req.params.id, before, item);
      return res.json(item);
    }),
    remove: safe(async (req, res) => {
      const before = await get(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
      if (!before) return res.status(404).json({ error: 'Registro nao encontrado.' });
      await audit(req, `${table}.delete`, table, req.params.id, before, null);
      await service.deleteResource(table, req.params.id);
      return res.status(204).end();
    }),
  };
}

const settings = safe(async (_req, res) => res.json(await service.getSettings()));
const updateSettings = safe(async (req, res) => {
  const before = await service.getSettings();
  const after = await service.updateSettings(req.body);
  await audit(req, 'settings.update', 'settings', 1, before, after);
  res.json(after);
});
const payments = safe(async (_req, res) => res.json(await service.getPaymentSettings()));
const updatePayments = safe(async (req, res) => {
  const before = await service.getPaymentSettings();
  const after = await service.updatePaymentSettings(req.body);
  await audit(req, 'payments.update', 'payment_settings', 1, before.settings, after.settings);
  res.json(after);
});
const auditLogs = safe(async (req, res) => res.json(await service.listAuditLogs(req.query)));

module.exports = { dashboard, users, user, updateUser, deleteUser, changePassword, resource, settings, updateSettings, payments, updatePayments, auditLogs };
