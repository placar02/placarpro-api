const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('publicacao forcada desativa caches de analise e propaga um runId', () => {
  assert.match(serverSource, /analysisCacheTtlMs:\s*freshAnalysis\s*\?\s*'0'/);
  assert.match(serverSource, /fullDailyCacheTtlMs:\s*'0'/);
  assert.match(serverSource, /fresh:\s*String\(freshAnalysis\)/);
  assert.match(serverSource, /analysisRunId,/);
  assert.match(serverSource, /fresh:\s*force,\s*analysisRunId/);
});

test('execucao fresh rejeita resposta antiga, cache hit e fallback', () => {
  assert.match(serverSource, /fullDaily\.analysisRunId\s*!==\s*analysisRunId/);
  assert.match(serverSource, /analysis\?\.meta\?\.cacheHit\s*===\s*true/);
  assert.match(serverSource, /nao pode reutilizar fallback\/cache/);
});

test('salva a execução nova como empty quando nenhuma análise foi aprovada', () => {
  assert.match(serverSource, /const persistNonPublishedAnalysisRun/);
  assert.match(serverSource, /generatedAnalyses:\s*analyses/);
  assert.match(serverSource, /status = 'empty'/);
  assert.match(serverSource, /publicationBlocked:\s*true/);
});
