const { validateDailyEvent } = require('./dailyEventEligibility');

function validateDailyPickPublication(payload, options = {}) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload deve ser um objeto'] };
  }

  if (!['prelive', 'live'].includes(payload.matchMode)) errors.push('matchMode invalido');
  if (!Array.isArray(payload.selectedEvents)) errors.push('selectedEvents deve ser uma lista');
  if (!payload.selection || typeof payload.selection !== 'object') errors.push('selection deve ser um objeto');
  if (payload.analysisResult !== null && payload.analysisResult !== undefined) {
    if (typeof payload.analysisResult !== 'object' || Array.isArray(payload.analysisResult)) {
      errors.push('analysisResult deve ser objeto ou null');
    } else if (!Array.isArray(payload.analysisResult.analyses)) {
      errors.push('analysisResult.analyses deve ser uma lista');
    }
  }

  if (Array.isArray(payload.selectedEvents)) {
    const ids = payload.selectedEvents.map((event) => event?.id).filter((id) => id !== undefined && id !== null);
    if (ids.length !== payload.selectedEvents.length) errors.push('toda partida deve possuir id');
    if (new Set(ids.map(String)).size !== ids.length) errors.push('selectedEvents nao pode conter partidas duplicadas');
    const requestedDate = options.date || payload?.selection?.analysisDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate || ''))) {
      errors.push('selection.analysisDate deve possuir data valida');
    } else {
      for (const event of payload.selectedEvents) {
        const validation = validateDailyEvent(event, requestedDate, {
          mode: options.mode || payload.matchMode,
          timeZone: options.timeZone,
          nowMs: options.nowMs,
        });
        if (!validation.valid) errors.push(`partida ${event?.id ?? 'sem-id'} invalida para publicacao: ${validation.reason}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function assertDailyPickPublication(payload, options = {}) {
  const validation = validateDailyPickPublication(payload, options);
  if (!validation.valid) {
    const error = new Error(`Publicacao diaria invalida: ${validation.errors.join('; ')}`);
    error.code = 'INVALID_DAILY_PICK_PUBLICATION';
    throw error;
  }
}

module.exports = { assertDailyPickPublication, validateDailyPickPublication };
