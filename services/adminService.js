const axios = require('axios');
const { pool, run, get, all } = require('../db');

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));
const slugify = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const pageMeta = (query = {}) => ({ page: clamp(query.page, 1, 100000), limit: clamp(query.limit || 20, 1, 100) });

async function dashboard() {
  const [metrics, monthlyUsers, monthlyRevenue, monthlySubscriptions, monthlyCancellations] = await Promise.all([
    get(`SELECT
      (SELECT COUNT(*)::int FROM users) total_users,
      (SELECT COUNT(*)::int FROM users WHERE role = 'premium' OR plano = 'premium') premium_users,
      (SELECT COUNT(*)::int FROM users WHERE role = 'free' AND COALESCE(plano, 'basico') <> 'premium') free_users,
      (SELECT COUNT(*)::int FROM users WHERE data_cadastro::date = CURRENT_DATE) new_users_today,
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM payment_sessions WHERE LOWER(status) IN ('approved','paid','authorized') AND created_at >= date_trunc('month', CURRENT_DATE)) revenue_month_cents,
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM payment_sessions WHERE LOWER(status) IN ('approved','paid','authorized')) revenue_total_cents,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'active') active_subscriptions,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'cancelled') cancelled_subscriptions,
      (SELECT COUNT(*)::int FROM entries) entries_created,
      (SELECT COUNT(*)::int FROM entries WHERE status = 'published') published_entries`),
    all(`SELECT to_char(month, 'YYYY-MM') label, COUNT(u.id)::int value
      FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') month
      LEFT JOIN users u ON date_trunc('month', u.data_cadastro) = month
      GROUP BY month ORDER BY month`),
    all(`SELECT to_char(month, 'YYYY-MM') label, COALESCE(SUM(p.amount), 0)::bigint value
      FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') month
      LEFT JOIN payment_sessions p ON date_trunc('month', p.created_at) = month AND LOWER(p.status) IN ('approved','paid','authorized')
      GROUP BY month ORDER BY month`),
    all(`SELECT to_char(month, 'YYYY-MM') label, COUNT(s.id)::int value
      FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') month
      LEFT JOIN subscriptions s ON date_trunc('month', s.created_at) = month
      GROUP BY month ORDER BY month`),
    all(`SELECT to_char(month, 'YYYY-MM') label, COUNT(s.id)::int value
      FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '5 months', date_trunc('month', CURRENT_DATE), interval '1 month') month
      LEFT JOIN subscriptions s ON date_trunc('month', s.cancelled_at) = month
      GROUP BY month ORDER BY month`),
  ]);

  const total = Number(metrics.total_users || 0);
  const premium = Number(metrics.premium_users || 0);
  let scraper = { ok: false, label: 'Indisponivel' };
  try {
    const response = await axios.get(`${String(process.env.PLACARPRO_API_URL || '').replace(/\/$/, '')}/health`, { timeout: 3000 });
    scraper = { ok: response.status === 200, label: response.status === 200 ? 'Operacional' : 'Instavel' };
  } catch (_error) {
    scraper = { ok: false, label: 'Indisponivel' };
  }

  return {
    metrics: { ...metrics, conversion_percent: total ? Number(((premium / total) * 100).toFixed(1)) : 0 },
    status: { api: { ok: true, label: 'Operacional' }, scraper },
    charts: { users: monthlyUsers, revenue: monthlyRevenue, subscriptions: monthlySubscriptions, cancellations: monthlyCancellations },
  };
}

async function listUsers(query = {}) {
  const { page, limit } = pageMeta(query);
  const where = [];
  const params = [];
  if (query.search) { params.push(`%${String(query.search).trim()}%`); where.push(`(u.nome ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  if (['admin', 'premium', 'free'].includes(query.role)) { params.push(query.role); where.push(`u.role = $${params.length}`); }
  if (['active', 'blocked'].includes(query.status)) { params.push(query.status); where.push(`u.status = $${params.length}`); }
  if (query.date_from) { params.push(query.date_from); where.push(`u.data_cadastro >= $${params.length}::date`); }
  if (query.date_to) { params.push(query.date_to); where.push(`u.data_cadastro < ($${params.length}::date + interval '1 day')`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*)::int total FROM users u ${clause}`, params);
  params.push(limit, (page - 1) * limit);
  const result = await pool.query(`SELECT u.id, u.nome, u.email, u.plano, u.role, u.status, u.plan_id,
      u.data_cadastro, u.last_login_at, p.name plan_name
    FROM users u LEFT JOIN plans p ON p.id = u.plan_id ${clause}
    ORDER BY u.data_cadastro DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { data: result.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } };
}

const getUser = (id) => get(`SELECT u.id, u.nome, u.email, u.plano, u.role, u.status, u.plan_id,
  u.banca_inicial, u.saldo_atual, u.data_cadastro, u.last_login_at, u.updated_at, p.name plan_name
  FROM users u LEFT JOIN plans p ON p.id = u.plan_id WHERE u.id = ?`, [id]);

async function updateUser(id, data) {
  const allowed = ['nome', 'email', 'role', 'status', 'plan_id'];
  const values = [];
  const sets = [];
  allowed.forEach((key) => {
    if (data[key] !== undefined) { sets.push(`${key} = ?`); values.push(data[key] === '' ? null : data[key]); }
  });
  if (data.role !== undefined) {
    sets.push('plano = ?');
    values.push(data.role === 'premium' ? 'premium' : (data.role === 'free' ? 'basico' : (data.plano || 'premium')));
  } else if (data.plano !== undefined && ['premium', 'basico'].includes(data.plano)) {
    sets.push('plano = ?'); values.push(data.plano);
    sets.push(`role = CASE WHEN role = 'admin' THEN 'admin' ELSE ? END`); values.push(data.plano === 'premium' ? 'premium' : 'free');
  }
  if (!sets.length) return getUser(id);
  values.push(id);
  await run(`UPDATE users SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values);
  return getUser(id);
}

async function deleteUser(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bankroll_history WHERE user_id = $1', [id]);
    await client.query('DELETE FROM bets WHERE user_id = $1', [id]);
    await client.query('DELETE FROM payment_sessions WHERE user_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function listResource(table, query = {}) {
  const allowed = new Set(['plans', 'entries', 'news', 'coupons']);
  if (!allowed.has(table)) throw new Error('Recurso invalido');
  const { page, limit } = pageMeta(query);
  const params = [];
  const where = [];
  if (query.search) {
    params.push(`%${query.search}%`);
    const cols = table === 'plans' ? ['name', 'description'] : table === 'entries' ? ['league', 'championship', 'market'] : table === 'news' ? ['title', 'category', 'author'] : ['code'];
    where.push(`(${cols.map((col) => `${col} ILIKE $${params.length}`).join(' OR ')})`);
  }
  if (query.status && table === 'entries') { params.push(query.status); where.push(`status = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*)::int total FROM ${table} ${clause}`, params);
  params.push(limit, (page - 1) * limit);
  const order = table === 'plans' ? 'display_order ASC, id ASC' : 'created_at DESC';
  const rows = await pool.query(`SELECT * FROM ${table} ${clause} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { data: rows.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } };
}

const definitions = {
  plans: { fields: ['name','slug','price_cents','description','benefits','color','badge','display_order','billing_period','active'], json: new Set(['benefits']) },
  entries: { fields: ['league','championship','market','odd','confidence','ai_analysis','event_time','image_url','status','pinned','hidden','publish_at','created_by'], json: new Set() },
  news: { fields: ['title','image_url','content','author','category','published','featured','created_by'], json: new Set() },
  coupons: { fields: ['code','discount_type','discount_value','max_uses','valid_from','valid_until','active'], json: new Set() },
};

async function saveResource(table, data, id = null) {
  const def = definitions[table];
  if (!def) throw new Error('Recurso invalido');
  const payload = { ...data };
  if (table === 'plans' && !payload.slug && payload.name) payload.slug = slugify(payload.name);
  const fields = def.fields.filter((field) => payload[field] !== undefined);
  const values = fields.map((field) => def.json.has(field) ? JSON.stringify(payload[field]) : (payload[field] === '' ? null : payload[field]));
  if (!id) {
    const placeholders = fields.map((field, index) => `$${index + 1}${def.json.has(field) ? '::jsonb' : ''}`);
    const result = await pool.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`, values);
    return result.rows[0];
  }
  if (!fields.length) return get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const sets = fields.map((field, index) => `${field} = $${index + 1}${def.json.has(field) ? '::jsonb' : ''}`);
  values.push(id);
  const result = await pool.query(`UPDATE ${table} SET ${sets.join(',')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
  return result.rows[0];
}

async function deleteResource(table, id) {
  if (!definitions[table]) throw new Error('Recurso invalido');
  return run(`DELETE FROM ${table} WHERE id = ?`, [id]);
}

const getSettings = () => get('SELECT * FROM app_settings WHERE id = 1');
async function updateSettings(data) {
  const fields = ['system_name','logo_url','favicon_url','primary_color','secondary_color','contact_email','contact_phone','social_links','home_text','user_message','maintenance_mode'];
  const selected = fields.filter((field) => data[field] !== undefined);
  if (!selected.length) return getSettings();
  const values = selected.map((field) => field === 'social_links' ? JSON.stringify(data[field]) : (data[field] === '' ? null : data[field]));
  values.push(1);
  await pool.query(`UPDATE app_settings SET ${selected.map((field, i) => `${field} = $${i + 1}${field === 'social_links' ? '::jsonb' : ''}`).join(',')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length}`, values);
  return getSettings();
}

const getPaymentSettings = async () => ({
  settings: await get('SELECT * FROM payment_settings WHERE id = 1'),
  plans: await all('SELECT * FROM plans ORDER BY display_order, id'),
  coupons: await all('SELECT * FROM coupons ORDER BY created_at DESC'),
});

async function updatePaymentSettings(data) {
  const fields = ['trial_days','max_accesses','default_discount_percent','mercado_pago_enabled','subscription_status'];
  const selected = fields.filter((field) => data[field] !== undefined);
  if (selected.length) {
    await run(`UPDATE payment_settings SET ${selected.map((field) => `${field} = ?`).join(',')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, selected.map((field) => data[field]));
  }
  return getPaymentSettings();
}

async function listAuditLogs(query = {}) {
  const { page, limit } = pageMeta(query);
  const params = [];
  const where = [];
  if (query.action) { params.push(query.action); where.push(`a.action = $${params.length}`); }
  if (query.entity_type) { params.push(query.entity_type); where.push(`a.entity_type = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*)::int total FROM audit_logs a ${clause}`, params);
  params.push(limit, (page - 1) * limit);
  const rows = await pool.query(`SELECT a.*, u.nome actor_name, u.email actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${clause} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { data: rows.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } };
}

async function listOddsSnapshots(query = {}) {
  const { page, limit } = pageMeta(query);
  const params = [];
  const where = [];
  if (query.event_id) { params.push(String(query.event_id)); where.push(`o.event_id = $${params.length}`); }
  if (query.provider) { params.push(String(query.provider)); where.push(`o.provider = $${params.length}`); }
  if (query.bookmaker) { params.push(`%${String(query.bookmaker)}%`); where.push(`o.bookmaker ILIKE $${params.length}`); }
  if (query.market) { params.push(`%${String(query.market)}%`); where.push(`(o.canonical_market ILIKE $${params.length} OR o.original_market ILIKE $${params.length})`); }
  if (query.date) { params.push(String(query.date)); where.push(`o.publication_date = $${params.length}::date`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*)::int total FROM bookmaker_odds_snapshots o ${clause}`, params);
  params.push(limit, (page - 1) * limit);
  const rows = await pool.query(
    `SELECT o.* FROM bookmaker_odds_snapshots o ${clause}
     ORDER BY o.captured_at DESC, o.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { data: rows.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } };
}

module.exports = { dashboard, listUsers, getUser, updateUser, deleteUser, listResource, saveResource, deleteResource, getSettings, updateSettings, getPaymentSettings, updatePaymentSettings, listAuditLogs, listOddsSnapshots };
