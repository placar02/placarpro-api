require('dotenv').config();

const DEFAULT_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
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
  await sendHeartbeat('starting');
  const response = await fetch(`${baseUrl}/api/internal/daily-pick/publish${force ? '?force=true' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-daily-pick-secret': secret,
    },
    body: JSON.stringify({ modes, force }),
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
    await fetch(`${heartbeatUrl}/api/internal/worker/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-daily-pick-secret': secret },
      body: JSON.stringify({ status, details }),
    });
  } catch (error) {
    console.warn(`Heartbeat ${status} nao enviado: ${error.message}`);
  }
}

main().catch(async (err) => {
  await sendHeartbeat('failed', { error: err.message });
  console.error('Erro ao publicar analise diaria:', err.message);
  process.exit(1);
});
