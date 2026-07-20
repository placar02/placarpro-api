const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

function resolvedRows(rows = []) {
  return rows.filter((row) => row.status === 'won' || row.status === 'lost');
}

function confidenceBucket(row) {
  const probability = finite(row.calibrated_probability ?? row.predicted_probability) || 0;
  return `${Math.floor(probability * 10) * 10}-${Math.min(100, (Math.floor(probability * 10) + 1) * 10)}%`;
}

function dataQualityBucket(row) {
  const quality = finite(row.data_quality) || 0;
  if (quality >= 85) return '85-100';
  if (quality >= 70) return '70-84';
  if (quality >= 55) return '55-69';
  return '0-54';
}

function calculateSegment(rows = [], label = 'total') {
  const resolved = resolvedRows(rows);
  let bankroll = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let brierTotal = 0;
  let logLossTotal = 0;
  let clvTotal = 0;
  let clvCount = 0;
  let expectedTotal = 0;
  let expectedCount = 0;
  let probabilityTotal = 0;

  const ordered = [...resolved].sort((a, b) => new Date(a.settled_at || a.kickoff_at || 0) - new Date(b.settled_at || b.kickoff_at || 0));
  for (const row of ordered) {
    const won = row.status === 'won' ? 1 : 0;
    const odd = finite(row.decimal_odds);
    bankroll += won ? Math.max(0, (odd || 1) - 1) : -1;
    peak = Math.max(peak, bankroll);
    maxDrawdown = Math.max(maxDrawdown, peak - bankroll);
    const probability = clamp(finite(row.calibrated_probability ?? row.predicted_probability) || 0.5, 0.001, 0.999);
    probabilityTotal += probability;
    brierTotal += Math.pow(won - probability, 2);
    logLossTotal += -(won * Math.log(probability) + (1 - won) * Math.log(1 - probability));
    const clv = finite(row.closing_line_value);
    if (clv !== null) { clvTotal += clv; clvCount += 1; }
    const ev = finite(row.expected_value);
    if (ev !== null) { expectedTotal += ev; expectedCount += 1; }
  }

  const wins = resolved.filter((row) => row.status === 'won').length;
  return {
    label,
    total: rows.length,
    resolved: resolved.length,
    pending: rows.filter((row) => row.status === 'pending').length,
    wins,
    losses: resolved.length - wins,
    hitRate: resolved.length ? Number((wins / resolved.length).toFixed(4)) : null,
    profitUnits: Number(bankroll.toFixed(4)),
    roi: resolved.length ? Number((bankroll / resolved.length).toFixed(4)) : null,
    yield: resolved.length ? Number((bankroll / resolved.length).toFixed(4)) : null,
    maxDrawdownUnits: Number(maxDrawdown.toFixed(4)),
    brierScore: resolved.length ? Number((brierTotal / resolved.length).toFixed(4)) : null,
    logLoss: resolved.length ? Number((logLossTotal / resolved.length).toFixed(4)) : null,
    averageClv: clvCount ? Number((clvTotal / clvCount).toFixed(4)) : null,
    averageExpectedValue: expectedCount ? Number((expectedTotal / expectedCount).toFixed(4)) : null,
    averagePredictedProbability: resolved.length ? Number((probabilityTotal / resolved.length).toFixed(4)) : null,
  };
}

function groupSegments(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const label = String(selector(row) || 'unknown');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  return [...groups.entries()].map(([label, values]) => calculateSegment(values, label))
    .sort((a, b) => b.resolved - a.resolved || a.label.localeCompare(b.label));
}

function buildCalibration(rows) {
  const buckets = groupSegments(resolvedRows(rows), confidenceBucket).map((segment) => {
    const bucketRows = resolvedRows(rows).filter((row) => confidenceBucket(row) === segment.label);
    const predicted = bucketRows.reduce((sum, row) => sum + (finite(row.calibrated_probability ?? row.predicted_probability) || 0), 0) / Math.max(1, bucketRows.length);
    return { ...segment, predictedRate: Number(predicted.toFixed(4)), calibrationError: segment.hitRate === null ? null : Number(Math.abs(segment.hitRate - predicted).toFixed(4)) };
  });
  const sample = buckets.reduce((sum, bucket) => sum + bucket.resolved, 0);
  const expectedCalibrationError = sample
    ? Number((buckets.reduce((sum, bucket) => sum + ((bucket.calibrationError || 0) * bucket.resolved), 0) / sample).toFixed(4))
    : null;
  return { expectedCalibrationError, buckets };
}

function buildBacktestReport(rows = [], options = {}) {
  const calibration = buildCalibration(rows);
  return {
    generatedAt: new Date().toISOString(),
    periodDays: Number(options.days || 365),
    summary: calculateSegment(rows),
    calibration,
    segments: {
      market: groupSegments(rows, (row) => row.market_family),
      tournament: groupSegments(rows, (row) => row.tournament_name),
      championshipTier: groupSegments(rows, (row) => `tier-${row.championship_tier || 'unknown'}`),
      confidence: calibration.buckets,
      dataQuality: groupSegments(rows, dataQualityBucket),
      month: groupSegments(rows, (row) => String(row.publication_date || '').slice(0, 7)),
    },
  };
}

function buildWeightRecommendations(report, minimumSample = 100) {
  return (report?.segments?.market || []).map((segment) => {
    if (segment.resolved < minimumSample || segment.hitRate === null) {
      return { marketFamily: segment.label, status: 'collecting', sampleSize: segment.resolved, requiredSample: minimumSample };
    }
    const calibrationGap = report.calibration.expectedCalibrationError || 0;
    const marketCalibrationDelta = segment.hitRate - (segment.averagePredictedProbability || segment.hitRate);
    const evidenceMultiplier = clamp(1 + (marketCalibrationDelta * 0.5) + ((segment.roi || 0) * 0.25) - (calibrationGap * 0.25), 0.9, 1.1);
    return {
      marketFamily: segment.label,
      status: 'review_required',
      sampleSize: segment.resolved,
      evidenceMultiplier: Number(evidenceMultiplier.toFixed(4)),
      rationale: `ROI ${(Number(segment.roi || 0) * 100).toFixed(1)}%, Brier ${segment.brierScore ?? 'n/a'}, desvio do mercado ${(marketCalibrationDelta * 100).toFixed(1)} p.p. e erro global ${(calibrationGap * 100).toFixed(1)}%.`,
      safeguards: { automaticallyApplied: false, boundedRange: [0.9, 1.1], predictedRate: segment.averagePredictedProbability, empiricalRate: segment.hitRate },
    };
  });
}

function buildOddsProviderReliability(payloadRows = []) {
  const providers = new Map();
  for (const row of payloadRows) {
    const payload = row?.payload || row || {};
    const primaryAudit = payload?.bestEntry?.meta?.oddsAudit;
    const uniqueAudits = primaryAudit
      ? [primaryAudit]
      : (payload?.meta?.decisionAudit?.candidates || []).map((candidate) => candidate?.oddsAudit).filter(Boolean);
    for (const audit of uniqueAudits) {
      for (const provider of audit.providers || []) {
        const source = String(provider.source || 'unknown');
        if (!providers.has(source)) providers.set(source, { provider: source, attempts: 0, available: 0, oddsFound: 0, reasons: {} });
        const metric = providers.get(source);
        metric.attempts += 1;
        if (provider.status === 'available') metric.available += 1;
        metric.oddsFound += Number(provider.oddsFound || 0);
        if (provider.reason) metric.reasons[provider.reason] = (metric.reasons[provider.reason] || 0) + 1;
      }
    }
  }
  return [...providers.values()].map((metric) => ({
    ...metric,
    availabilityRate: metric.attempts ? Number((metric.available / metric.attempts).toFixed(4)) : null,
  })).sort((a, b) => b.availabilityRate - a.availabilityRate || b.oddsFound - a.oddsFound);
}

function evaluateOperationalAlerts(snapshot, thresholds = {}) {
  const alerts = [];
  const workerMaxHours = Number(thresholds.workerMaxHours || 30);
  const publicationMaxHours = Number(thresholds.publicationMaxHours || 30);
  const overdueLimit = Number(thresholds.overduePredictions || 20);
  if (!snapshot.worker || snapshot.worker.ageHours > workerMaxHours || snapshot.worker.status === 'failed') {
    alerts.push({ fingerprint: 'daily-worker-stale', severity: 'critical', message: 'Worker diario ausente, atrasado ou com falha.', details: snapshot.worker || null });
  }
  if (!snapshot.publication || snapshot.publication.ageHours > publicationMaxHours || snapshot.publication.status === 'failed') {
    alerts.push({ fingerprint: 'daily-publication-stale', severity: 'critical', message: 'Publicacao diaria ausente, atrasada ou com falha.', details: snapshot.publication || null });
  }
  if (Number(snapshot.predictions?.overdue || 0) >= overdueLimit) {
    alerts.push({ fingerprint: 'prediction-settlement-backlog', severity: 'warning', message: 'Fila de liquidacao acima do limite.', details: snapshot.predictions });
  }
  if (Number(snapshot.odds?.events24h || 0) === 0) {
    alerts.push({ fingerprint: 'odds-no-recent-snapshots', severity: 'warning', message: 'Nenhum snapshot de odd real nas ultimas 24 horas.', details: snapshot.odds });
  }
  for (const provider of snapshot.odds?.reliability || []) {
    if (provider.attempts >= 3 && provider.availabilityRate < 0.3) {
      alerts.push({
        fingerprint: `odds-provider-degraded-${provider.provider}`,
        severity: 'warning',
        message: `Provedor de odds ${provider.provider} com disponibilidade abaixo de 30%.`,
        details: provider,
      });
    }
  }
  return alerts;
}

module.exports = { buildBacktestReport, buildOddsProviderReliability, buildWeightRecommendations, calculateSegment, evaluateOperationalAlerts };
