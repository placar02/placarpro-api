function validateAnalysisDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('Data invalida. Use o formato YYYY-MM-DD.');
  }
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('Data inexistente no calendario.');
  }
  return text;
}

function validateManualPublicationDate(value, options = {}) {
  const target = validateAnalysisDate(value);
  const today = validateAnalysisDate(options.today);
  const maxDaysAhead = Math.max(0, Number(options.maxDaysAhead ?? 14));
  const targetTime = Date.parse(`${target}T12:00:00Z`);
  const todayTime = Date.parse(`${today}T12:00:00Z`);
  const daysAhead = Math.round((targetTime - todayTime) / 86400000);
  if (daysAhead < 0) throw new Error('Nao e permitido publicar retroativamente uma analise pre-jogo.');
  if (daysAhead > maxDaysAhead) throw new Error(`A data pode estar no maximo ${maxDaysAhead} dias a frente.`);
  return target;
}

module.exports = { validateAnalysisDate, validateManualPublicationDate };
