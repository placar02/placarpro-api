require('dotenv').config();
const { validateAnalysisDate } = require('../services/analysisDate');
const { isTransientPublicationPollError } = require('../services/publicationPolling');

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
const publicationWaitMs = Math.max(
  60000,
  Number(process.env.DAILY_PICK_PUBLISH_WAIT_MS || 15 * 60 * 1000)
);
const publicationPollMs = Math.max(
  1000,
  Number(process.env.DAILY_PICK_PUBLISH_POLL_MS || 5000)
);

if (!secret) {
  console.error('Defina DAILY_PICK_PUBLISH_SECRET no .env antes de publicar a analise diaria.');
  process.exit(1);
}

async function main() {
  console.log(`Publicacao solicitada: data=${requestedDate || 'automatica'}, destino=${baseUrl}, force=${force}`);
  await sendHeartbeat('starting', { requestedDate });
  const query = new URLSearchParams({ async: 'true' });
  if (force) query.set('force', 'true');
  const response = await fetch(`${baseUrl}/api/internal/daily-pick/publish?${query}`, {
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

  const finalPayload = payload.accepted
    ? await waitForPublication(payload.jobId, payload.date || requestedDate)
    : payload;
  console.log(JSON.stringify(finalPayload, null, 2));
  await sendHeartbeat('healthy', {
    date: finalPayload.date,
    results: summarizePublicationResults(finalPayload.results),
    recoveredFromAsyncTracking: Boolean(payload.accepted),
  });
}

function summarizePublicationResults(results) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    mode: item?.mode,
    success: Boolean(item?.success),
    status: item?.status,
    analysesPublished: Number(item?.analysesPublished || 0),
    eligible: Number(item?.eligible || 0),
    discardedCount: Array.isArray(item?.discarded) ? item.discarded.length : 0,
    error: item?.error || null,
  }));
}

async function waitForPublication(jobId, date) {
  if (!jobId) throw new Error('API aceitou a publicacao sem retornar jobId.');
  const deadline = Date.now() + publicationWaitMs;
  let lastStatus = 'starting';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/internal/daily-pick/publication-jobs/${encodeURIComponent(jobId)}`, {
        headers: { 'x-daily-pick-secret': secret },
        signal: AbortSignal.timeout(10000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || response.statusText);
      const job = payload?.job;
      lastStatus = job?.status || 'pending';
      if (job?.status === 'completed') {
        const analysesPublished = Number(job.result?.analysesPublished || 0);
        const eligible = Number(job.result?.eligible || 0);
        const success = analysesPublished > 0 || eligible > 0 || job.result?.success === true;
        return {
          ...job.result,
          success,
          accepted: success,
          tracked: true,
          jobStatus: 'completed',
          error: success ? null : job.result?.error || 'Publicacao concluida sem partidas elegiveis.',
          jobId,
        };
      }
      if (job?.status === 'failed') {
        throw new Error(job.error || `Publicacao de ${date} falhou.`);
      }
    } catch (error) {
      if (!isTransientPublicationPollError(error)) throw error;
      lastStatus = error.message;
    }
    process.stdout.write(`Aguardando publicacao de ${date} (${lastStatus})...\n`);
    await new Promise((resolve) => setTimeout(resolve, publicationPollMs));
  }
  throw new Error(`Publicacao de ${date} nao terminou em ${Math.round(publicationWaitMs / 1000)} segundos.`);
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
