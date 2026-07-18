const test = require('node:test');
const assert = require('node:assert/strict');
const { analysisMarketFamily, settlePredictionOutcome } = require('../services/analysisAccuracy');

test('classifica familias de mercado sem depender do texto da IA', () => {
  assert.equal(analysisMarketFamily({ market: 'Gols', recommendation: 'Over 2.5 gols' }), 'goals');
  assert.equal(analysisMarketFamily({ market: 'Escanteios', recommendation: 'Mais de 9.5 escanteios' }), 'corners');
  assert.equal(analysisMarketFamily({ market: 'Cartoes', recommendation: 'Mais de 4.5 cartoes' }), 'cards');
});

test('liquida mercados de gols pelo placar final', () => {
  const event = { homeScore: { current: 2 }, awayScore: { current: 1 } };
  assert.equal(settlePredictionOutcome({ market_family: 'goals', recommendation: 'Over 2.5 gols' }, event), 'won');
  assert.equal(settlePredictionOutcome({ market_family: 'goals', recommendation: 'Under 2.5 gols' }, event), 'lost');
  assert.equal(settlePredictionOutcome({ market_family: 'goals', recommendation: 'Ambas as equipes marcam' }, event), 'won');
});

test('liquida escanteios somente com estatistica objetiva', () => {
  const event = { score: { home: 1, away: 0 } };
  const statistics = { groups: [{ items: [{ name: 'Escanteios', home: 7, away: 4 }] }] };
  assert.equal(settlePredictionOutcome({ market_family: 'corners', recommendation: 'Mais de 9.5 escanteios' }, event, statistics), 'won');
  assert.equal(settlePredictionOutcome({ market_family: 'corners', recommendation: 'Mais de 9.5 escanteios' }, event, null), null);
});

test('anula mercado que nao pode ser verificado com seguranca', () => {
  const event = { score: { home: 1, away: 0 } };
  assert.equal(settlePredictionOutcome({ market_family: 'player', recommendation: 'Jogador marca' }, event), 'void');
});
