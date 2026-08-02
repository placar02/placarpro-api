const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUserAnalysisSummary } = require('../services/analysisSummary');

test('transforma justificativa técnica em resumo humano baseado nas confirmações da decisão', () => {
  const summary = buildUserAnalysisSummary({
    recommendation: 'Over 2.5 gols',
    rationale: 'Over 2.5 em 64% da amostra.',
    meta: { decisionAudit: {
      selectedMarket: 'Gols',
      selectedRecommendation: 'Over 2.5 gols',
      candidates: [{
        market: 'Gols', recommendation: 'Over 2.5 gols', rejectionReasons: [],
        confirmations: ['forma recente de ambas as equipes', 'desempenho casa e fora', 'dados corroborados por 3 fontes'],
      }],
    } },
  }, { homeName: 'Colorado Rapids', awayName: 'Austin FC' });

  assert.ok(summary.length >= 250 && summary.length <= 350);
  assert.doesNotMatch(summary, /amostra|feature|evidence|data quality|edge|probability|threshold|64%/i);
  assert.match(summary, /desempenho recente/i);
  assert.match(summary, /mandante em casa/i);
  assert.match(summary, /sinais confirmados|usados em conjunto/i);
  assert.doesNotMatch(summary, /\.\.\.$/);
});

test('preserva explicação da IA quando ela já atende ao contrato de apresentação', () => {
  const rationale = 'O desempenho recente de Time A e Time B mostra ataques produtivos e defesas que permitem oportunidades. O rendimento do mandante em casa e do visitante fora reforça o mercado escolhido. A combinação desses sinais torna a recomendação coerente para o confronto, sem depender de um único indicador.';
  assert.equal(buildUserAnalysisSummary({ rationale }), rationale);
});
