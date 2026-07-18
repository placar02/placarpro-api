require('dotenv').config();

const DEFAULT_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const baseUrl = String(process.env.DAILY_PICK_PUBLISH_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const secret = String(process.env.DAILY_PICK_PUBLISH_SECRET || '').trim();

if (!secret) {
  console.error('Defina DAILY_PICK_PUBLISH_SECRET no .env antes de consultar metricas.');
  process.exit(1);
}

async function main() {
  const response = await fetch(`${baseUrl}/api/internal/analysis-predictions/metrics`, {
    headers: { 'x-daily-pick-secret': secret },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || response.statusText);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error('Erro ao consultar metricas:', err.message);
  process.exit(1);
});
