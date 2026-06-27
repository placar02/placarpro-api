const { run } = require('../db');

async function audit(req, action, entityType, entityId, oldValues, newValues) {
  return run(
    `INSERT INTO audit_logs
      (actor_user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)`,
    [
      req.user?.id || null,
      action,
      entityType,
      entityId == null ? null : String(entityId),
      oldValues == null ? null : JSON.stringify(oldValues),
      newValues == null ? null : JSON.stringify(newValues),
      req.ip || null,
      req.headers['user-agent'] || null,
    ]
  );
}

module.exports = { audit };
