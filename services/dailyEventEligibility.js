const TERMINAL = {
  finished: 'partida ja encerrada',
  ended: 'partida ja encerrada',
  final: 'partida ja encerrada',
  afterextra: 'partida ja encerrada',
  afterpenalties: 'partida ja encerrada',
  postponed: 'partida adiada',
  canceled: 'partida cancelada',
  cancelled: 'partida cancelada',
  abandoned: 'partida abandonada',
  interrupted: 'partida abandonada',
};

function eventTimestamp(event) {
  return Number(event?.startTimestamp || event?.startTime || event?.matchTime || 0);
}

function eventDateKey(event, timeZone = 'America/Sao_Paulo') {
  const timestamp = eventTimestamp(event);
  if (!timestamp) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function normalizedStatus(event) {
  return String(event?.status?.type || event?.status?.description || event?.status || '').toLowerCase();
}

function validateDailyEvent(event, requestedDate, options = {}) {
  const timeZone = options.timeZone || process.env.DAILY_PICK_TIMEZONE || 'America/Sao_Paulo';
  const mode = String(options.mode || 'prelive').toLowerCase();
  const timestamp = eventTimestamp(event);
  if (!event?.id) return { valid: false, reason: 'partida sem identificador' };
  if (!timestamp) return { valid: false, reason: 'partida sem horario valido' };
  const eventDate = eventDateKey(event, timeZone);
  if (eventDate !== requestedDate) return { valid: false, reason: 'partida fora da data', eventDate };

  const status = normalizedStatus(event);
  const terminal = Object.entries(TERMINAL).find(([value]) => status.includes(value));
  if (terminal) return { valid: false, reason: terminal[1], eventDate };
  if (mode !== 'live' && ['inprogress', 'live'].some((value) => status.includes(value))) {
    return { valid: false, reason: 'partida ja iniciada', eventDate };
  }
  if (mode !== 'live' && timestamp * 1000 <= (options.nowMs ?? Date.now())) {
    return { valid: false, reason: 'partida ja iniciada', eventDate };
  }
  const providerTimestamps = [...new Set(Object.values(event?.providerStartTimestamps || {})
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0))];
  if (providerTimestamps.length > 1) {
    const differenceMinutes = (Math.max(...providerTimestamps) - Math.min(...providerTimestamps)) / 60;
    const allowed = Number(options.maxProviderTimeDifferenceMinutes
      ?? process.env.SCHEDULE_MAX_PROVIDER_TIME_DIFFERENCE_MINUTES
      ?? 15);
    if (differenceMinutes > allowed) {
      return {
        valid: false,
        reason: 'horario inconsistente entre provedores',
        eventDate,
        providerTimeDifferenceMinutes: Number(differenceMinutes.toFixed(1)),
      };
    }
  }
  return { valid: true, eventDate };
}

function auditDailyEvents(events, requestedDate, options = {}) {
  const eligible = [];
  const discarded = [];
  for (const event of events || []) {
    const validation = validateDailyEvent(event, requestedDate, options);
    if (validation.valid) eligible.push(event);
    else discarded.push({ event, ...validation });
  }
  return { eligible, discarded };
}

function replaceGate(report, gateName, patch) {
  if (!Array.isArray(report?.gates)) return report;
  return {
    ...report,
    gates: report.gates.map((gate) => gate.gate === gateName ? { ...gate, ...patch } : gate),
  };
}

function updatePrepublicationPipelineReport(data, audit, durationMs = 0) {
  const report = data?.selection?.pipeline?.report;
  if (!report || !Array.isArray(report.matches)) return data;
  const eligibleIds = new Set(audit.eligible.map((event) => String(event.id)));
  const discardedById = new Map(audit.discarded.map((item) => [String(item.event?.id), item]));
  const matches = report.matches.map((match) => {
    const eventId = String(match.eventId);
    if (eligibleIds.has(eventId)) {
      return replaceGate(match, 'prepublication', {
        status: 'PASS',
        outcome: 'ELIGIBLE',
        reasons: [],
        durationMs,
        details: { checkedAt: new Date().toISOString() },
      });
    }
    const discarded = discardedById.get(eventId);
    if (!discarded) return match;
    const updated = replaceGate(match, 'prepublication', {
      status: 'FAIL',
      outcome: 'ELIMINATED',
      reasons: [discarded.reason],
      durationMs,
      details: { eventDate: discarded.eventDate },
    });
    return { ...updated, finalStatus: 'REJECTED', eliminatedAt: 'prepublication' };
  });
  return {
    ...data,
    selection: {
      ...(data.selection || {}),
      pipeline: {
        ...(data.selection?.pipeline || {}),
        report: {
          ...report,
          matches,
          summary: {
            ...(report.summary || {}),
            prepublicationEligible: audit.eligible.length,
            prepublicationDiscarded: audit.discarded.length,
          },
        },
      },
    },
  };
}

function markPipelineReportsPublished(data) {
  const report = data?.selection?.pipeline?.report;
  if (!report || !Array.isArray(report.matches)) return data;
  const eligibleIds = new Set((data.selectedEvents || []).map((event) => String(event.id)));
  const analysisById = new Map((data?.analysisResult?.analyses || []).map((analysis) => [String(analysis.eventId), analysis]));
  let published = 0;
  const matches = report.matches.map((match) => {
    const eventId = String(match.eventId);
    if (!eligibleIds.has(eventId) || !analysisById.has(eventId)) return match;
    published += 1;
    const analysis = analysisById.get(eventId);
    const updated = replaceGate(match, 'publication', {
      status: 'PASS',
      outcome: 'PUBLISHED',
      reasons: [],
      details: { persistedAt: new Date().toISOString() },
    });
    return {
      ...updated,
      finalStatus: analysis?.analysisStatus === 'approved'
        ? 'APPROVED'
        : analysis?.analysisStatus === 'waiting_odds'
          ? 'WAITING_ODDS'
          : 'REJECTED',
    };
  });
  return {
    ...data,
    selection: {
      ...(data.selection || {}),
      pipeline: {
        ...(data.selection?.pipeline || {}),
        report: {
          ...report,
          matches,
          summary: { ...(report.summary || {}), published },
        },
      },
    },
  };
}

function buildPrepublicationFailureMessage(audit) {
  const counts = new Map();
  for (const item of audit.discarded || []) {
    const reason = item.reason || 'motivo não informado';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const reasons = [...counts.entries()].map(([reason, count]) => `${reason} (${count})`);
  return reasons.length
    ? `Validação pré-publicação eliminou todas as partidas: ${reasons.join('; ')}.`
    : 'Validação pré-publicação não recebeu partidas para avaliar.';
}

function filterDailyPickForPublication(data, requestedDate, options = {}) {
  const validationStartedAt = process.hrtime.bigint();
  const scheduleAudit = auditDailyEvents(data?.selectedEvents || [], requestedDate, options);
  const sourceAnalyses = Array.isArray(data?.analysisResult?.analyses)
    ? data.analysisResult.analyses
    : [];
  const approvedAnalyses = sourceAnalyses.filter((analysis) =>
    analysis?.analysisStatus === 'approved'
    && Number(analysis?.confidence || 0) > 0
    && analysis?.bestEntry
  );
  const approvedIds = new Set(approvedAnalyses.map((analysis) => String(analysis.eventId)));
  const rejectedByDecision = scheduleAudit.eligible
    .filter((event) => !approvedIds.has(String(event.id)))
    .map((event) => ({
      event,
      valid: false,
      reason: 'partida nao aprovada pelo Decision Engine',
      eventDate: eventDateKey(event, options.timeZone || process.env.DAILY_PICK_TIMEZONE || 'America/Sao_Paulo'),
    }));
  const audit = {
    eligible: scheduleAudit.eligible.filter((event) => approvedIds.has(String(event.id))),
    discarded: [...scheduleAudit.discarded, ...rejectedByDecision],
  };
  const eligibleIds = new Set(audit.eligible.map((event) => String(event.id)));
  const analyses = approvedAnalyses.filter((analysis) => eligibleIds.has(String(analysis?.eventId)));
  const currentPrimary = data?.analysisResult;
  const primaryIsEligible = currentPrimary?.eventId !== undefined
    && eligibleIds.has(String(currentPrimary.eventId));
  const primary = primaryIsEligible ? currentPrimary : analyses[0];
  const analysisResult = primary ? {
    ...primary,
    analyses,
    bestEntry: primary.bestEntry || primary,
  } : null;
  const eligibleCount = audit.eligible.length;
  const analysesPublished = analyses.length;
  const success = eligibleCount > 0 || analysesPublished > 0;
  const failureMessage = buildPrepublicationFailureMessage(audit);

  const validatedData = updatePrepublicationPipelineReport({
    ...data,
    success,
    error: success ? null : data?.error || data?.selection?.error || failureMessage,
    selectedEvents: audit.eligible,
    analysisResult,
    selection: {
      ...(data?.selection || {}),
      success,
      status: success ? 'ready_for_publication' : 'empty',
      error: success ? null : data?.selection?.error || data?.error || failureMessage,
      selectedByQuality: eligibleCount,
      analysesPublished,
      finalPreliveValidation: {
        checkedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        eligible: eligibleCount,
        discarded: audit.discarded.map(({ event, reason, eventDate }) => ({
          eventId: event?.id,
          reason,
          eventDate,
        })),
      },
    },
  }, audit, Number(process.hrtime.bigint() - validationStartedAt) / 1e6);

  return {
    data: validatedData,
    discarded: audit.discarded,
  };
}

module.exports = {
  auditDailyEvents,
  eventDateKey,
  eventTimestamp,
  filterDailyPickForPublication,
  markPipelineReportsPublished,
  validateDailyEvent,
};
