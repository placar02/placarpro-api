const { run } = require('../db');
const logger = require('./logger');

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
      oldValues == null ? null : JSON.stringify(logger.redact(oldValues)),
      newValues == null ? null : JSON.stringify(logger.redact(newValues)),
      logger.anonymizeIp(req.ip),
      String(req.headers['user-agent'] || '').slice(0, 500) || null,
    ]
  );
}

module.exports = { audit };
