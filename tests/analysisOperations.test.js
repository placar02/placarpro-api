const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBacktestReport, buildOddsProviderReliability, buildWeightRecommendations, evaluateOperationalAlerts } = require('../services/analysisOperations');

function prediction(index, overrides = {}) {
  const won = index % 4 !== 0;
  return {
    publication_date: `2026-07-${String((index % 20) + 1).padStart(2, '0')}`,
    kickoff_at: new Date(2026, 6, (index % 20) + 1).toISOString(),
    settled_at: new Date(2026, 6, (index % 20) + 1, 3).toISOString(),
    tournament_name: index % 2 ? 'Brasileirao Serie A' : 'Premier League',
    market_family: index % 3 ? 'goals' : 'winner',
    predicted_probability: 0.75,
    calibrated_probability: 0.75,
    decimal_odds: 1.8,
    expected_value: 0.08,
    data_quality: 88,
    market_evidence: 85,
    championship_tier: 1,
    status: won ? 'won' : 'lost',
    closing_line_value: 0.02,
    ...overrides,
  };
}

test('backtest calcula retorno, risco, calibracao e segmentos', () => {
  const rows = Array.from({ length: 120 }, (_, index) => prediction(index));
  const report = buildBacktestReport(rows, { days: 365 });
  assert.equal(report.summary.resolved, 120);
  assert.equal(report.summary.hitRate, 0.75);
  assert.ok(report.summary.roi > 0);
  assert.ok(report.summary.maxDrawdownUnits >= 0);
  assert.ok(report.summary.brierScore >= 0);
  assert.ok(report.summary.logLoss >= 0);
  assert.equal(report.segments.market.length, 2);
  assert.equal(report.calibration.expectedCalibrationError, 0);
});

test('recomendacao de peso exige amostra e nunca e aplicada automaticamente', () => {
  const collecting = buildWeightRecommendations(buildBacktestReport([prediction(1)]), 100);
  assert.equal(collecting[0].status, 'collecting');
  const ready = buildWeightRecommendations(buildBacktestReport(Array.from({ length: 300 }, (_, index) => prediction(index))), 100);
  assert.ok(ready.some((item) => item.status === 'review_required'));
  for (const item of ready.filter((entry) => entry.status === 'review_required')) {
    assert.equal(item.safeguards.automaticallyApplied, false);
    assert.ok(item.evidenceMultiplier >= 0.9 && item.evidenceMultiplier <= 1.1);
  }
});

test('monitor detecta worker, publicacao, odds e liquidacao degradados', () => {
  const alerts = evaluateOperationalAlerts({
    worker: { status: 'failed', ageHours: 40 },
    publication: { status: 'failed', ageHours: 40 },
    predictions: { overdue: 30 },
    odds: { events24h: 0 },
  });
  assert.deepEqual(new Set(alerts.map((alert) => alert.fingerprint)), new Set([
    'daily-worker-stale', 'daily-publication-stale', 'prediction-settlement-backlog', 'odds-no-recent-snapshots',
  ]));
});

test('mede disponibilidade real por provedor de odds a partir da auditoria', () => {
  const payloadRows = Array.from({ length: 4 }, (_, index) => ({ payload: {
    bestEntry: { meta: { oddsAudit: { providers: [
      { source: 'betano', status: index === 0 ? 'available' : 'unavailable', oddsFound: index === 0 ? 12 : 0, reason: index ? 'timeout' : undefined },
      { source: 'sofascore', status: 'available', oddsFound: 5 },
    ] } } },
  } }));
  const reliability = buildOddsProviderReliability(payloadRows);
  assert.equal(reliability.find((item) => item.provider === 'betano').availabilityRate, 0.25);
  assert.equal(reliability.find((item) => item.provider === 'sofascore').availabilityRate, 1);
});

test('processa lote grande de forma deterministica sem chamadas externas', () => {
  const rows = Array.from({ length: 10000 }, (_, index) => prediction(index));
  const startedAt = Date.now();
  const first = buildBacktestReport(rows);
  const second = buildBacktestReport(rows);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.segments.market, second.segments.market);
  assert.ok(Date.now() - startedAt < 2000);
});
