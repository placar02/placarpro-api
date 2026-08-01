const test = require('node:test');
const assert = require('node:assert/strict');
const { assertDailyPickPublication, validateDailyPickPublication } = require('../services/dailyPickContract');
const { filterDailyPickForPublication, markPipelineReportsPublished } = require('../services/dailyEventEligibility');

const validPayload = {
  matchMode: 'prelive',
  selectedEvents: [
    { id: 10, startTimestamp: Date.parse('2026-07-26T20:00:00Z') / 1000, status: { type: 'notstarted' } },
    { id: 20, startTimestamp: Date.parse('2026-07-26T22:00:00Z') / 1000, status: { type: 'notstarted' } },
  ],
  analysisResult: { analyses: [] },
  selection: { strategy: 'data-quality', analysisDate: '2026-07-26' },
};

test('aceita contrato de publicacao compativel', () => {
  const options = { nowMs: Date.parse('2026-07-26T15:00:00Z') };
  assert.equal(validateDailyPickPublication(validPayload, options).valid, true);
  assert.doesNotThrow(() => assertDailyPickPublication(validPayload, options));
});

test('rejeita evento sem id e duplicidade', () => {
  const missingId = validateDailyPickPublication({ ...validPayload, selectedEvents: [{}] });
  const duplicated = validateDailyPickPublication({ ...validPayload, selectedEvents: [{ id: 10 }, { id: 10 }] });
  assert.equal(missingId.valid, false);
  assert.equal(duplicated.valid, false);
});

test('rejeita resultado de analise estruturalmente incompleto', () => {
  assert.throws(
    () => assertDailyPickPublication({ ...validPayload, analysisResult: { bestEntry: null } }),
    /analysisResult\.analyses/
  );
});

test('rejeita publicacao com partida fora da data solicitada', () => {
  const invalid = {
    ...validPayload,
    selectedEvents: [{
      id: 30,
      startTimestamp: Date.parse('2026-07-25T20:00:00Z') / 1000,
      status: { type: 'notstarted' },
    }],
  };
  const result = validateDailyPickPublication(invalid, {
    nowMs: Date.parse('2026-07-25T15:00:00Z'),
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /partida fora da data/);
});

test('rejeita publicacao prelive com partida ja iniciada', () => {
  const result = validateDailyPickPublication(validPayload, {
    nowMs: Date.parse('2026-07-26T23:00:00Z'),
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /partida ja iniciada/);
});

test('remove partida iniciada e sua analise antes da publicacao', () => {
  const data = {
    ...validPayload,
    analysisResult: {
      eventId: 10,
      analyses: [
        { eventId: 10, analysisStatus: 'approved', confidence: 80, bestEntry: { eventId: 10 } },
        { eventId: 20, analysisStatus: 'approved', confidence: 79, bestEntry: { eventId: 20 } },
      ],
    },
  };
  const result = filterDailyPickForPublication(data, '2026-07-26', {
    mode: 'prelive',
    nowMs: Date.parse('2026-07-26T21:00:00Z'),
  });
  assert.deepEqual(result.data.selectedEvents.map((event) => event.id), [20]);
  assert.deepEqual(result.data.analysisResult.analyses.map((analysis) => analysis.eventId), [20]);
  assert.equal(result.data.analysisResult.eventId, 20);
  assert.equal(result.discarded[0].reason, 'partida ja iniciada');
});

test('limpa erro obsoleto da triagem quando fallback publicou partidas elegiveis', () => {
  const data = {
    ...validPayload,
    analysisResult: {
      eventId: 10,
      analyses: [
        { eventId: 10, analysisStatus: 'approved', confidence: 80, bestEntry: { eventId: 10 } },
        { eventId: 20, analysisStatus: 'approved', confidence: 79, bestEntry: { eventId: 20 } },
      ],
    },
    selection: {
      strategy: 'compatible-fallback',
      error: 'Triagem diaria nao selecionou partidas elegiveis para publicacao.',
    },
  };
  const result = filterDailyPickForPublication(data, '2026-07-26', {
    mode: 'prelive',
    nowMs: Date.parse('2026-07-26T15:00:00Z'),
  });

  assert.equal(result.data.success, true);
  assert.equal(result.data.error, null);
  assert.equal(result.data.selection.success, true);
  assert.equal(result.data.selection.error, null);
  assert.equal(result.data.selection.selectedByQuality, 2);
  assert.equal(result.data.selection.analysesPublished, 2);
  assert.equal(result.data.selection.finalPreliveValidation.eligible, 2);
  assert.deepEqual(result.data.selection.finalPreliveValidation.discarded, []);
});

test('preserva erro somente quando nao ha evento nem analise elegivel', () => {
  const result = filterDailyPickForPublication({
    ...validPayload,
    selectedEvents: [],
    analysisResult: null,
    selection: { error: 'Falha real de selecao.' },
  }, '2026-07-26', {
    mode: 'prelive',
    nowMs: Date.parse('2026-07-26T15:00:00Z'),
  });

  assert.equal(result.data.success, false);
  assert.equal(result.data.error, 'Falha real de selecao.');
  assert.equal(result.data.selection.error, 'Falha real de selecao.');
});

test('nao publica partidas elegiveis por horario quando o Decision Engine rejeitou', () => {
  const result = filterDailyPickForPublication({
    ...validPayload,
    analysisResult: {
      eventId: 10,
      analyses: [
        { eventId: 10, analysisStatus: 'rejected', confidence: 0, bestEntry: null },
        { eventId: 20, analysisStatus: 'waiting_odds', confidence: 80, bestEntry: { eventId: 20 } },
      ],
    },
  }, '2026-07-26', {
    mode: 'prelive',
    nowMs: Date.parse('2026-07-26T15:00:00Z'),
  });

  assert.equal(result.data.success, false);
  assert.equal(result.data.selection.status, 'empty');
  assert.equal(result.data.selection.analysesPublished, 0);
  assert.equal(result.data.selection.finalPreliveValidation.eligible, 0);
  assert.equal(result.data.selectedEvents.length, 0);
  assert.equal(result.data.analysisResult, null);
  assert.equal(result.discarded.length, 2);
  assert.match(result.discarded[0].reason, /Decision Engine/);
});

test('atualiza os gates de pre-publicacao e publicacao sem alterar a decisao', () => {
  const pendingGate = (gate) => ({
    gate,
    status: 'WARNING',
    outcome: 'PENDING',
    durationMs: 0,
    reasons: ['Aguardando.'],
  });
  const data = {
    ...validPayload,
    selectedEvents: [validPayload.selectedEvents[0]],
    analysisResult: {
      eventId: 10,
      analyses: [{ eventId: 10, analysisStatus: 'approved', confidence: 80, bestEntry: { eventId: 10 } }],
    },
    selection: {
      ...validPayload.selection,
      pipeline: {
        report: {
          summary: { published: 0 },
          matches: [{
            eventId: '10',
            finalStatus: 'PENDING_PUBLICATION',
            gates: [pendingGate('prepublication'), pendingGate('publication')],
          }],
        },
      },
    },
  };

  const validated = filterDailyPickForPublication(data, '2026-07-26', {
    mode: 'prelive',
    nowMs: Date.parse('2026-07-26T15:00:00Z'),
  }).data;
  const prepublication = validated.selection.pipeline.report.matches[0].gates
    .find((gate) => gate.gate === 'prepublication');
  assert.equal(prepublication.status, 'PASS');
  assert.equal(prepublication.outcome, 'ELIGIBLE');
  assert.ok(prepublication.durationMs >= 0);

  const published = markPipelineReportsPublished(validated);
  const match = published.selection.pipeline.report.matches[0];
  const publication = match.gates.find((gate) => gate.gate === 'publication');
  assert.equal(publication.status, 'PASS');
  assert.equal(publication.outcome, 'PUBLISHED');
  assert.equal(match.finalStatus, 'APPROVED');
  assert.equal(published.selection.pipeline.report.summary.published, 1);
  assert.equal(published.analysisResult.analyses[0].confidence, 80);
});
