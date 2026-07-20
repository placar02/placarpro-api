const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAnalysisDate, validateManualPublicationDate } = require('../services/analysisDate');

test('aceita data valida no formato canonico', () => {
  assert.equal(validateAnalysisDate('2026-07-20'), '2026-07-20');
});

test('rejeita formato e data inexistente', () => {
  assert.throws(() => validateAnalysisDate('20/07/2026'), /YYYY-MM-DD/);
  assert.throws(() => validateAnalysisDate('2026-02-30'), /inexistente/);
});

test('publicacao manual aceita hoje e futuro dentro do limite', () => {
  assert.equal(validateManualPublicationDate('2026-07-19', { today: '2026-07-19', maxDaysAhead: 14 }), '2026-07-19');
  assert.equal(validateManualPublicationDate('2026-08-02', { today: '2026-07-19', maxDaysAhead: 14 }), '2026-08-02');
});

test('publicacao manual bloqueia passado e futuro distante', () => {
  assert.throws(() => validateManualPublicationDate('2026-07-18', { today: '2026-07-19' }), /retroativamente/);
  assert.throws(() => validateManualPublicationDate('2026-08-03', { today: '2026-07-19', maxDaysAhead: 14 }), /14 dias/);
});
