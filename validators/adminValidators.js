const roles = new Set(['admin', 'premium', 'free']);
const userStatuses = new Set(['active', 'blocked']);

const text = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const optionalText = (value, max = 1000) => value == null || value === '' || text(value, max);
const id = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
const email = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const color = (value) => /^#[0-9a-f]{6}$/i.test(String(value || ''));

function validate(kind, payload = {}, partial = false) {
  const errors = [];
  const required = (key, valid, label = key) => {
    if (payload[key] == null && partial) return;
    if (!valid(payload[key])) errors.push(`${label} invalido.`);
  };

  if (kind === 'user') {
    if (payload.nome !== undefined && !text(payload.nome, 255)) errors.push('Nome invalido.');
    if (payload.email !== undefined && !email(payload.email)) errors.push('Email invalido.');
    if (payload.role !== undefined && !roles.has(payload.role)) errors.push('Papel invalido.');
    if (payload.status !== undefined && !userStatuses.has(payload.status)) errors.push('Status invalido.');
    if (payload.plan_id !== undefined && payload.plan_id !== null && !id(payload.plan_id)) errors.push('Plano invalido.');
  }
  if (kind === 'plan') {
    required('name', (v) => text(v, 120), 'Nome');
    required('price_cents', (v) => Number.isInteger(Number(v)) && Number(v) >= 0, 'Valor');
    if (payload.color !== undefined && !color(payload.color)) errors.push('Cor invalida.');
    if (payload.benefits !== undefined && !Array.isArray(payload.benefits)) errors.push('Beneficios invalidos.');
  }
  if (kind === 'entry') {
    required('league', (v) => text(v, 160), 'Liga');
    required('market', (v) => text(v, 255), 'Mercado');
    required('odd', (v) => Number(v) > 1, 'Odd');
    if (payload.confidence !== undefined && (Number(payload.confidence) < 0 || Number(payload.confidence) > 100)) errors.push('Confianca invalida.');
  }
  if (kind === 'news') {
    required('title', (v) => text(v, 220), 'Titulo');
    required('content', (v) => text(v, 100000), 'Texto');
  }
  if (kind === 'settings') {
    if (payload.system_name !== undefined && !text(payload.system_name, 120)) errors.push('Nome do sistema invalido.');
    if (payload.primary_color !== undefined && !color(payload.primary_color)) errors.push('Cor principal invalida.');
    if (payload.secondary_color !== undefined && !color(payload.secondary_color)) errors.push('Cor secundaria invalida.');
    if (payload.contact_email && !email(payload.contact_email)) errors.push('Email de contato invalido.');
    ['logo_url', 'favicon_url', 'contact_phone', 'home_text', 'user_message'].forEach((key) => {
      if (payload[key] !== undefined && !optionalText(payload[key], 10000)) errors.push(`${key} invalido.`);
    });
  }
  return errors;
}

function validateBody(kind, partial = false) {
  return (req, res, next) => {
    const errors = validate(kind, req.body, partial);
    if (errors.length) return res.status(422).json({ error: 'Dados invalidos.', details: errors });
    return next();
  };
}

module.exports = { validate, validateBody, roles, userStatuses };
