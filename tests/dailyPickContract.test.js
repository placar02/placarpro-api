const test = require('node:test');
const assert = require('node:assert/strict');
const { assertDailyPickPublication, validateDailyPickPublication } = require('../services/dailyPickContract');

const validPayload = {
  matchMode: 'prelive',
  selectedEvents: [{ id: 10 }, { id: 20 }],
  analysisResult: { analyses: [] },
  selection: { strategy: 'data-quality' },
};

test('aceita contrato de publicacao compativel', () => {
  assert.equal(validateDailyPickPublication(validPayload).valid, true);
  assert.doesNotThrow(() => assertDailyPickPublication(validPayload));
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
