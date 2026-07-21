require('dotenv').config();
const { validateAnalysisDate } = require('../services/analysisDate');

const DEFAULT_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

const argv = process.argv.slice(2);
const args = new Set(argv);
const npmDateArgument = String(process.env.npm_config_date || '').trim();
const npmForceArgument = String(process.env.npm_config_force || '').trim().toLowerCase();
const force = args.has('--force') || ['1', 'true', 'yes'].includes(npmForceArgument);
const inlineDateArgument = argv.find((arg) => arg.startsWith('--date='));
const dateFlagIndex = argv.indexOf('--date');
const dateArgument = inlineDateArgument !== undefined
  ? inlineDateArgument.slice('--date='.length)
  : dateFlagIndex >= 0 ? argv[dateFlagIndex + 1] : npmDateArgument || null;
let requestedDate = null;
if ((inlineDateArgument !== undefined || dateFlagIndex >= 0 || npmDateArgument) && (!dateArgument || dateArgument.startsWith('--'))) {
  console.error('Informe a data apos --date usando o formato YYYY-MM-DD.');
  process.exit(1);
}
if (dateArgument) {
  try {
    requestedDate = validateAnalysisDate(dateArgument);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
const baseUrl = String(process.env.DAILY_PICK_PUBLISH_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const heartbeatUrl = String(process.env.DAILY_PICK_HEARTBEAT_URL || baseUrl).replace(/\/+$/, '');
const secret = String(process.env.DAILY_PICK_PUBLISH_SECRET || '').trim();
const modes = String(process.env.DAILY_PICK_PUBLISH_MODES || process.env.DAILY_PICK_SCHEDULER_MODES || 'prelive')
  .split(',')
  .map((mode) => mode.trim())
  .filter(Boolean);

if (!secret) {
  console.error('Defina DAILY_PICK_PUBLISH_SECRET no .env antes de publicar a analise diaria.');
  process.exit(1);
}

async function main() {
  console.log(`Publicacao solicitada: data=${requestedDate || 'automatica'}, destino=${baseUrl}, force=${force}`);
  await sendHeartbeat('starting', { requestedDate });
  const response = await fetch(`${baseUrl}/api/internal/daily-pick/publish${force ? '?force=true' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-daily-pick-secret': secret,
    },
    body: JSON.stringify({ modes, force, date: requestedDate }),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(payload.error || payload.raw || response.statusText);
  }

  console.log(JSON.stringify(payload, null, 2));
  await sendHeartbeat('healthy', { date: payload.date, results: payload.results });
}

async function sendHeartbeat(status, details = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${heartbeatUrl}/api/internal/worker/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-daily-pick-secret': secret },
      body: JSON.stringify({ status, details }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return true;
  } catch (error) {
    console.warn(`Heartbeat ${status} nao enviado: ${error.message}`);
    return false;
  }
}

main().catch(async (err) => {
  await sendHeartbeat('failed', { error: err.message });
  console.error('Erro ao publicar analise diaria:', err.message);
  process.exit(1);
});
