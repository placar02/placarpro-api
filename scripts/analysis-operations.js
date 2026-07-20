require('dotenv').config();

const baseUrl = String(process.env.DAILY_PICK_PUBLISH_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const secret = String(process.env.DAILY_PICK_PUBLISH_SECRET || '').trim();

if (!secret) throw new Error('Defina DAILY_PICK_PUBLISH_SECRET antes de consultar a operacao.');

fetch(`${baseUrl}/api/internal/analysis-operations`, { headers: { 'x-daily-pick-secret': secret } })
  .then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || response.statusText);
    console.log(JSON.stringify(payload, null, 2));
  })
  .catch((error) => { console.error('Erro no monitoramento:', error.message); process.exitCode = 1; });
