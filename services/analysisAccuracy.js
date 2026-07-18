const normalizeAnalysisText = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\bmais de\b/g, 'over')
  .replace(/\bmenos de\b/g, 'under')
  .replace(/\bambas as equipes marcam\b|\bambas marcam\b/g, 'btts')
  .replace(/[^a-z0-9.]+/g, ' ')
  .trim();

const analysisMarketFamily = (analysis) => {
  const text = normalizeAnalysisText(`${analysis?.market || ''} ${analysis?.recommendation || ''}`);
  if (/escanteio|corner/.test(text)) return 'corners';
  if (/cart|amarelo|vermelho|falta/.test(text)) return 'cards';
  if (/chute|finaliza|remate|jogador|gol de|assistencia/.test(text)) return 'player';
  if (/over|under|gol|btts|both teams score/.test(text)) return 'goals';
  if (/resultado|vencedor|winner|1x2|empate|draw/.test(text)) return 'winner';
  return 'unknown';
};

const extractNumericStatTotal = (payload, pattern) => {
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    const label = normalizeAnalysisText(`${value.name || ''} ${value.key || ''} ${value.type || ''}`);
    const home = Number(String(value.home ?? value.homeValue ?? '').replace(',', '.'));
    const away = Number(String(value.away ?? value.awayValue ?? '').replace(',', '.'));
    if (pattern.test(label) && Number.isFinite(home) && Number.isFinite(away)) return home + away;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const found = visit(child);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(payload);
};

const settlePredictionOutcome = (prediction, event, statistics) => {
  const recommendation = normalizeAnalysisText(prediction.recommendation);
  const homeScore = Number(event?.homeScore?.current ?? event?.score?.home ?? event?.homeScore);
  const awayScore = Number(event?.awayScore?.current ?? event?.score?.away ?? event?.awayScore);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  const lineMatch = recommendation.match(/\b(\d+(?:\.\d+)?)\b/);
  const line = lineMatch ? Number(lineMatch[1]) : null;

  if (prediction.market_family === 'goals') {
    if (/btts/.test(recommendation)) {
      const happened = homeScore > 0 && awayScore > 0;
      const wantsNo = /nao| no /.test(` ${recommendation} `);
      return (wantsNo ? !happened : happened) ? 'won' : 'lost';
    }
    if (line !== null && /over/.test(recommendation)) return homeScore + awayScore > line ? 'won' : 'lost';
    if (line !== null && /under/.test(recommendation)) return homeScore + awayScore < line ? 'won' : 'lost';
  }

  if (prediction.market_family === 'winner') {
    const home = normalizeAnalysisText(prediction.home_team);
    const away = normalizeAnalysisText(prediction.away_team);
    if (/empate|draw/.test(recommendation)) return homeScore === awayScore ? 'won' : 'lost';
    if (home && recommendation.includes(home)) return homeScore > awayScore ? 'won' : 'lost';
    if (away && recommendation.includes(away)) return awayScore > homeScore ? 'won' : 'lost';
  }

  if (prediction.market_family === 'corners' || prediction.market_family === 'cards') {
    const total = extractNumericStatTotal(statistics, prediction.market_family === 'corners'
      ? /escanteio|corner/
      : /cart|amarelo|vermelho/);
    if (total === null || line === null) return null;
    if (/over/.test(recommendation)) return total > line ? 'won' : 'lost';
    if (/under/.test(recommendation)) return total < line ? 'won' : 'lost';
  }

  return 'void';
};

module.exports = { analysisMarketFamily, settlePredictionOutcome };
