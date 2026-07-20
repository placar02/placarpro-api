require('dotenv').config();

const baseUrl = String(process.env.LOAD_TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const path = String(process.env.LOAD_TEST_PATH || '/api/health');
const requests = Math.max(1, Math.min(10000, Number(process.env.LOAD_TEST_REQUESTS || 100)));
const concurrency = Math.max(1, Math.min(100, Number(process.env.LOAD_TEST_CONCURRENCY || 10)));
const timeoutMs = Math.max(500, Number(process.env.LOAD_TEST_TIMEOUT_MS || 10000));

const durations = [];
let nextIndex = 0;
let failures = 0;

async function worker() {
  while (nextIndex < requests) {
    nextIndex += 1;
    const startedAt = performance.now();
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      durations.push(performance.now() - startedAt);
    }
  }
}

const percentile = (sorted, value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] || 0;

Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
  const sorted = durations.sort((a, b) => a - b);
  const report = {
    target: `${baseUrl}${path}`,
    requests,
    concurrency,
    failures,
    errorRate: Number((failures / requests).toFixed(4)),
    latencyMs: {
      p50: Number(percentile(sorted, 0.5).toFixed(2)),
      p95: Number(percentile(sorted, 0.95).toFixed(2)),
      p99: Number(percentile(sorted, 0.99).toFixed(2)),
      max: Number((sorted.at(-1) || 0).toFixed(2)),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.errorRate > Number(process.env.LOAD_TEST_MAX_ERROR_RATE || 0.01)) process.exitCode = 1;
});
