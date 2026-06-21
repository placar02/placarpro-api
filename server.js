const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const { run, get, all } = require('./db');

const app = express();
app.disable('x-powered-by');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-betleverage-key-2026';
const FRONTEND_URL = process.env.FRONTEND_URL ;
const PLACARPRO_API_URL = process.env.PLACARPRO_API_URL ;
const MERCADOPAGO_API_URL = 'https://api.mercadopago.com';
const BASIC_MAX_ODD = 1.5;
const PREMIUM_ENTRY_LIMIT = 5;
const PREMIUM_PLAN_PRICE = Number(process.env.PREMIUM_PLAN_PRICE_CENTS || 4990);
const PREMIUM_PLAN_PRICE_BRL = Number((PREMIUM_PLAN_PRICE / 100).toFixed(2));
const PREMIUM_PRODUCT_EXTERNAL_ID = process.env.MERCADOPAGO_PREMIUM_PRODUCT_EXTERNAL_ID || 'placarpro-premium';
const DAILY_PICK_ANALYSIS_TIMEOUT_MS = Number(process.env.DAILY_PICK_ANALYSIS_TIMEOUT_MS || 30000);
const DAILY_PICK_CACHE_TTL_MS = Number(process.env.DAILY_PICK_CACHE_TTL_MS || 15 * 60 * 1000);

let dailyPickRefreshPromise = null;
let dailyPickRuntimeCache = null;

const allowedOrigins = (process.env.CORS_ORIGINS || `${FRONTEND_URL},http://localhost:5173,http://localhost:5174,http://localhost:5175`)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origem nao autorizada pelo CORS'));
  },
  credentials: true,
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
});

const rateLimitBuckets = new Map();
const rateLimit = ({ windowMs, max, keyPrefix }) => (req, res, next) => {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `${keyPrefix}:${ip}`;
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }

  bucket.count += 1;
  if (bucket.count > max) {
    return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em instantes.' });
  }

  return next();
};

app.use(express.json({
  limit: '100kb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth' }));
app.use('/api/payments', rateLimit({ windowMs: 60 * 1000, max: 40, keyPrefix: 'payments' }));

const asMoney = (value) => Number(value || 0).toFixed(2).replace('.', ',');

const mapBetStatus = (resultado) => {
  if (resultado === 'green') return 'Ganha';
  if (resultado === 'red') return 'Perdida';
  return 'Pendente';
};

const formatBetValue = (bet) => {
  if (bet.resultado === 'green') return `+ R$ ${asMoney(bet.lucro_prejuizo)}`;
  if (bet.resultado === 'red') return `- R$ ${asMoney(Math.abs(bet.lucro_prejuizo))}`;
  return `Stake R$ ${asMoney(bet.valor_apostado)}`;
};

const extractOdd = (entry) => {
  const metaOdd = Number(entry?.meta?.decimal_odds || entry?.bestEntry?.meta?.decimal_odds || entry?.odd);
  if (Number.isFinite(metaOdd) && metaOdd > 1) return metaOdd;

  const match = String(entry?.recommendation || '').match(/@\s*(\d+(?:[.,]\d{1,2})?)/);
  if (!match) return null;
  const odd = Number(match[1].replace(',', '.'));
  return Number.isFinite(odd) && odd > 1 ? odd : null;
};

const normalizeOddText = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\bmais de\b/g, 'over')
  .replace(/\bmenos de\b/g, 'under')
  .replace(/\bambas marcam\b/g, 'both teams score')
  .replace(/\bambas equipes marcam\b/g, 'both teams score')
  .replace(/\bempate anula\b/g, 'draw no bet')
  .replace(/[^a-z0-9.]+/g, ' ')
  .trim();

const flattenOddsChoices = (oddsData) => {
  const groups = Object.values(oddsData?.markets_by_group || {});
  const choices = [];

  for (const group of groups) {
    for (const market of group?.markets || []) {
      if (market.suspended) continue;

      for (const choice of market.choices || []) {
        const decimalOdd = Number(choice.decimal_odds);
        if (!Number.isFinite(decimalOdd) || decimalOdd <= 1) continue;

        choices.push({
          marketName: market.market_name || market.market_group || '',
          choiceName: choice.name || choice.slip_content || '',
          decimalOdd,
          meta: {
            decimal_odds: decimalOdd,
            oddsMarketId: market.market_id,
            oddsMarketName: market.market_name || market.market_group,
            oddsChoiceName: choice.name || choice.slip_content,
            oddsMarketPeriod: market.market_period,
            oddsChoiceGroup: market.choice_group,
            oddsMatchedBy: 'odds-route',
          },
        });
      }
    }
  }

  return choices;
};

const scoreOddChoice = (entry, choice) => {
  const entryText = normalizeOddText(`${entry?.market || ''} ${entry?.recommendation || ''}`);
  const marketText = normalizeOddText(choice.marketName);
  const choiceText = normalizeOddText(choice.choiceName);
  let score = 0;

  if (marketText && entryText.includes(marketText)) score += 4;
  if (choiceText && entryText.includes(choiceText)) score += 6;
  if (choiceText && choiceText.includes(entryText)) score += 3;

  const entryTokens = new Set(entryText.split(' ').filter((token) => token.length >= 3));
  for (const token of marketText.split(' ').filter((item) => item.length >= 3)) {
    if (entryTokens.has(token)) score += 1;
  }
  for (const token of choiceText.split(' ').filter((item) => item.length >= 3)) {
    if (entryTokens.has(token)) score += 2;
  }

  return score;
};

const enrichEntryWithOdds = (entry, oddsData) => {
  if (!entry || extractOdd(entry)) return entry;

  const choices = flattenOddsChoices(oddsData);
  if (choices.length === 0) return entry;

  const ranked = choices
    .map((choice) => ({ choice, score: scoreOddChoice(entry, choice) }))
    .sort((a, b) => b.score - a.score || a.choice.decimalOdd - b.choice.decimalOdd);
  const best = ranked[0]?.score >= 3 ? ranked[0].choice : null;

  if (!best) return entry;

  return {
    ...entry,
    meta: {
      ...(entry.meta || {}),
      ...best.meta,
    },
  };
};

const enrichAnalysisWithOdds = (analysisResult, oddsData) => {
  if (!analysisResult || !oddsData?.markets_by_group) return analysisResult;
  const enrichedTopLevel = enrichEntryWithOdds(analysisResult, oddsData);

  return {
    ...enrichedTopLevel,
    bestEntry: analysisResult.bestEntry
      ? enrichEntryWithOdds(analysisResult.bestEntry, oddsData)
      : analysisResult.bestEntry,
    recommendations: Array.isArray(analysisResult.recommendations)
      ? analysisResult.recommendations.map((entry) => enrichEntryWithOdds(entry, oddsData))
      : analysisResult.recommendations,
  };
};

const hasRealOddEntry = (analysisResult, events = []) => {
  return expandRecommendations(analysisResult, events).some((entry) => Number.isFinite(Number(entry.odd)) && Number(entry.odd) > 1);
};

const summarizeText = (text, maxLength = 220) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const sentenceEnd = normalized.slice(0, maxLength).lastIndexOf('.');
  if (sentenceEnd > 80) return normalized.slice(0, sentenceEnd + 1);

  const lastSpace = normalized.slice(0, maxLength - 1).lastIndexOf(' ');
  return `${normalized.slice(0, lastSpace > 80 ? lastSpace : maxLength - 1)}...`;
};

const getLiveMinute = (event) => {
  const statusType = String(event?.status?.type || '').toLowerCase();
  if (!['inprogress', 'live'].includes(statusType)) return null;

  const periodStart = Number(event?.time?.currentPeriodStartTimestamp || event?.currentPeriodStartTimestamp || 0);
  if (!periodStart) return null;

  const elapsed = Math.max(1, Math.floor((Date.now() / 1000 - periodStart) / 60));
  const max = Number(event?.time?.max || 90);
  const extra = Number(event?.time?.extra || 0);
  return Math.min(elapsed, max + extra);
};

const getLocalDateKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.DAILY_PICK_TIMEZONE || 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(date);

const getLocalDateKeyOffset = (days = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return getLocalDateKey(date);
};

const getEventStartTimestamp = (event) => Number(event?.startTimestamp || event?.startTime || 0);

const getEventDateKey = (event) => {
  const timestamp = getEventStartTimestamp(event);
  if (!timestamp) return null;
  return getLocalDateKey(new Date(timestamp * 1000));
};

const getEventStatusType = (event) => String(event?.status?.type || '').toLowerCase();

const isFinishedStatus = (event) => [
  'finished',
  'ended',
  'final',
  'afterextra',
  'afterpenalties',
  'canceled',
  'cancelled',
  'postponed',
  'abandoned',
  'interrupted',
].includes(getEventStatusType(event));

const isLiveStatus = (event) => ['inprogress', 'live'].includes(getEventStatusType(event));

const isTodayUpcomingEvent = (event) => {
  if (!event?.id) return false;
  if (isFinishedStatus(event) || isLiveStatus(event)) return false;

  const timestamp = getEventStartTimestamp(event);
  if (!timestamp) return false;

  const eventDate = getEventDateKey(event);
  if (eventDate !== getLocalDateKey()) return false;

  return timestamp * 1000 > Date.now() - 5 * 60 * 1000;
};

const isUpcomingEvent = (event) => {
  if (!event?.id) return false;
  if (isFinishedStatus(event) || isLiveStatus(event)) return false;

  const timestamp = getEventStartTimestamp(event);
  if (!timestamp) return false;

  return timestamp * 1000 > Date.now() - 5 * 60 * 1000;
};

const filterEligibleDailyEvents = (events = []) => events
  .filter(isTodayUpcomingEvent)
  .sort((a, b) => getEventStartTimestamp(a) - getEventStartTimestamp(b));

const filterUpcomingEvents = (events = []) => events
  .filter(isUpcomingEvent)
  .sort((a, b) => getEventStartTimestamp(a) - getEventStartTimestamp(b));

const normalizeEntry = (entry, events = []) => {
  if (!entry) return null;

  const entryEventId = entry.eventId || (events.length === 1 ? events[0]?.id : null);
  const matchedEvent = events.find((event) => String(event.id) === String(entryEventId));
  const fullRationale = String(entry.rationale || '').trim();

  return {
    ...entry,
    eventId: entryEventId,
    odd: extractOdd(entry),
    fullRationale,
    rationale: summarizeText(fullRationale),
    analysisSummary: summarizeText(fullRationale),
    advancedAnalysis: {
      dataCoverage: entry.dataCoverage || null,
      keyFactors: Array.isArray(entry.keyFactors) ? entry.keyFactors : [],
      playerAnalysis: entry.playerAnalysis || null,
      refereeAnalysis: entry.refereeAnalysis || null,
      marketBreakdown: entry.marketBreakdown || null,
      confidenceDrivers: Array.isArray(entry.confidenceDrivers) ? entry.confidenceDrivers : [],
      avoidMarkets: Array.isArray(entry.avoidMarkets) ? entry.avoidMarkets : [],
      riskAnalysis: entry.riskAnalysis || null,
      dataSupport: Array.isArray(entry.dataSupport) ? entry.dataSupport : [],
      warningSigns: Array.isArray(entry.warningSigns) ? entry.warningSigns : [],
      riskLevel: entry.riskLevel || null,
    },
    homeTeamName: matchedEvent?.homeTeam?.name || entry.homeTeamName || 'Casa',
    awayTeamName: matchedEvent?.awayTeam?.name || entry.awayTeamName || 'Fora',
    tournamentName: matchedEvent?.tournament?.name || entry.tournamentName || 'Desconhecido',
    startTimestamp: matchedEvent?.startTimestamp || entry.startTimestamp || null,
    status: matchedEvent?.status || entry.status || null,
    liveMinute: getLiveMinute(matchedEvent) || entry.liveMinute || null,
    score: matchedEvent ? {
      home: matchedEvent.homeScore?.display ?? matchedEvent.homeScore?.current ?? null,
      away: matchedEvent.awayScore?.display ?? matchedEvent.awayScore?.current ?? null,
    } : entry.score || null,
  };
};

const expandRecommendations = (analysisResult, events) => {
  const analyses = [
    analysisResult,
    ...(analysisResult?.analyses || []),
  ].filter(Boolean);

  return analyses
    .flatMap((analysis) => {
      const eventId = analysis.eventId || analysisResult?.eventId || analysis.meta?.eventId;
      const entries = [];

      if (analysis.bestEntry) {
        entries.push({ ...analysis, ...analysis.bestEntry, eventId });
      }

      if (Array.isArray(analysis.recommendations) && analysis.recommendations.length > 0) {
        entries.push(...analysis.recommendations.map((recommendation) => ({ ...analysis, ...recommendation, eventId })));
      }

      if (entries.length === 0) {
        entries.push({ ...analysis, eventId });
      }

      return entries;
    })
    .map((entry) => normalizeEntry(entry, events))
    .filter(Boolean);
};

const selectVariedEntries = (analysisResult, events, limit = PREMIUM_ENTRY_LIMIT) => {
  const eventIds = new Set(events.map((event) => String(event.id)));
  const expanded = expandRecommendations(analysisResult, events)
    .filter((entry) => eventIds.has(String(entry.eventId)));
  const byEvent = new Map();

  for (const entry of expanded) {
    const eventId = String(entry.eventId || '');
    if (!eventId) continue;

    const current = byEvent.get(eventId);
    const entryScore = Number(entry.confidence || 0);
    const currentScore = Number(current?.confidence || 0);

    if (!current || entryScore > currentScore) {
      byEvent.set(eventId, entry);
    }
  }

  const varied = events
    .map((event) => byEvent.get(String(event.id)))
    .filter(Boolean)
    .slice(0, limit);

  if (varied.length >= Math.min(limit, events.length)) return varied;

  for (const entry of expanded) {
    const alreadySelected = varied.some((selected) => String(selected.eventId) === String(entry.eventId));
    if (!alreadySelected) varied.push(entry);
    if (varied.length >= limit) break;
  }

  return varied;
};

const selectBasicEntry = (analysisResult, events) => {
  const candidates = expandRecommendations(analysisResult, events);
  const allowedEntry = candidates.find((entry) => entry.odd && entry.odd > 1 && entry.odd <= BASIC_MAX_ODD);

  if (allowedEntry) return allowedEntry;

  return candidates[0] || null;
};

const buildFallbackAnalysisFromEvents = (events = []) => {
  const analyses = events.map((event) => {
    const fallbackOdds = Array.isArray(event.fallbackOdds) ? event.fallbackOdds : [];
    const firstOdd = fallbackOdds.find((item) => Number(item?.odd) > 1);
    const market = firstOdd?.market || 'Pre-jogo';
    const recommendation = firstOdd?.recommendation || 'Acompanhar mercado antes da entrada';

    return {
      eventId: event.id,
      confidence: firstOdd?.odd ? 58 : 45,
      market,
      recommendation,
      rationale: firstOdd?.odd
        ? 'Entrada gerada por fallback de calendario e odds alternativas porque o provedor principal bloqueou a consulta.'
        : 'Jogo encontrado por fallback de calendario. Odds reais nao vieram do provedor alternativo, entao registre somente apos confirmar a cotacao manualmente.',
      meta: firstOdd?.odd ? {
        decimal_odds: firstOdd.odd,
        oddsMatchedBy: 'fallback-provider',
      } : {
        oddsMatchedBy: 'unavailable',
      },
      bestEntry: {
        market,
        recommendation,
        confidence: firstOdd?.odd ? 58 : 45,
        rationale: firstOdd?.odd
          ? 'Entrada gerada por fallback de calendario e odds alternativas porque o provedor principal bloqueou a consulta.'
          : 'Jogo encontrado por fallback de calendario. Odds reais nao vieram do provedor alternativo, entao registre somente apos confirmar a cotacao manualmente.',
        meta: firstOdd?.odd ? {
          decimal_odds: firstOdd.odd,
          oddsMatchedBy: 'fallback-provider',
        } : {
          oddsMatchedBy: 'unavailable',
        },
      },
    };
  });

  if (analyses.length === 0) return null;

  return {
    ...analyses[0],
    bestEntry: analyses[0].bestEntry,
    recommendations: analyses.map((analysis) => ({
      eventId: analysis.eventId,
      market: analysis.market,
      recommendation: analysis.recommendation,
      confidence: analysis.confidence,
      rationale: analysis.rationale,
      meta: analysis.meta,
    })),
    analyses,
    analysisSource: 'fallback-provider',
  };
};

const isPaidStatus = (status) => ['PAID', 'COMPLETED', 'APPROVED', 'approved'].includes(String(status || '').toUpperCase());

const mercadoPagoRequest = async (method, path, data, params, extraHeaders = {}) => {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN nao configurado');
  }

  const response = await axios({
    method,
    url: `${MERCADOPAGO_API_URL}${path}`,
    data,
    params,
    headers: {
      Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    timeout: 15000,
  });

  return response.data;
};

const getMercadoPagoErrorMessage = (err) => {
  const apiError = err.response?.data;
  const causeText = Array.isArray(apiError?.cause)
    ? apiError.cause.map((item) => item.description).filter(Boolean).join(' ')
    : '';

  if (causeText.includes('Invalid card_token_id')) {
    return 'Token do cartao invalido, expirado ou ja usado. Gere um novo token preenchendo o formulario de cartao novamente.';
  }

  if (typeof apiError?.message === 'string') return apiError.message;
  if (typeof apiError?.error === 'string') return apiError.error;
  if (typeof apiError === 'string') return apiError;
  return err.message || 'Erro desconhecido no Mercado Pago';
};

const getMercadoPagoErrorDetails = (err) => {
  const apiError = err.response?.data;
  const cause = Array.isArray(apiError?.cause)
    ? apiError.cause.map((item) => [item.code, item.description].filter(Boolean).join(': ')).filter(Boolean)
    : [];

  return {
    status: err.response?.status,
    message: getMercadoPagoErrorMessage(err),
    cause,
    raw: apiError,
  };
};

const sanitizeMercadoPagoPayload = (payload = {}) => ({
  transaction_amount: payload.transaction_amount,
  description: payload.description,
  installments: payload.installments,
  payment_method_id: payload.payment_method_id,
  issuer_id: payload.issuer_id,
  external_reference: payload.external_reference,
  payer: payload.payer ? {
    email: payload.payer.email,
    identification: payload.payer.identification ? {
      type: payload.payer.identification.type,
      number: payload.payer.identification.number ? '***' : undefined,
    } : undefined,
  } : undefined,
  metadata: payload.metadata,
  has_token: Boolean(payload.token),
  has_notification_url: Boolean(payload.notification_url),
});

const isPublicHttpsUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch (_err) {
    return false;
  }
};

const activatePremiumFromPayment = async (payment) => {
  const externalId = payment?.external_reference || payment?.externalReference || payment?.metadata?.external_id;
  const preferenceId = payment?.preference_id || payment?.preferenceId;
  const session = externalId
    ? await get('SELECT * FROM payment_sessions WHERE external_id = ?', [externalId])
    : await get('SELECT * FROM payment_sessions WHERE checkout_id = ?', [preferenceId]);

  if (!session) return null;

  await run(
    'UPDATE payment_sessions SET status = ?, raw_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [payment.status || 'pending', JSON.stringify(payment), session.id]
  );

  if (isPaidStatus(payment.status)) {
    await run("UPDATE users SET plano = 'premium' WHERE id = ?", [session.user_id]);
  }

  return session;
};

const getMercadoPagoPaymentById = async (paymentId) => {
  if (!paymentId) return null;
  return mercadoPagoRequest('GET', `/v1/payments/${paymentId}`);
};

const findMercadoPagoPaymentByExternalId = async (externalId) => {
  if (!externalId) return null;

  const response = await mercadoPagoRequest('GET', '/v1/payments/search', null, {
    external_reference: externalId,
    sort: 'date_created',
    criteria: 'desc',
  });

  const results = Array.isArray(response?.results) ? response.results : [];
  return results[0] || null;
};

const getPaymentNotificationUrl = () => {
  if (isPublicHttpsUrl(process.env.MERCADOPAGO_WEBHOOK_URL)) {
    return process.env.MERCADOPAGO_WEBHOOK_URL;
  }

  const fallbackUrl = process.env.PUBLIC_API_URL
    ? `${process.env.PUBLIC_API_URL}/api/payments/webhook`
    : undefined;

  return isPublicHttpsUrl(fallbackUrl) ? fallbackUrl : undefined;
};

const isMercadoPagoTestMode = () => (
  String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').startsWith('TEST-')
  || String(process.env.MERCADOPAGO_PUBLIC_KEY || '').startsWith('TEST-')
);

const getMercadoPagoPayerEmail = (preferredEmail, fallbackEmail) => {
  const testBuyerEmail = String(process.env.MERCADOPAGO_TEST_BUYER_EMAIL || '').trim();
  if (isMercadoPagoTestMode() && testBuyerEmail) return testBuyerEmail;

  return preferredEmail || fallbackEmail;
};

const fetchEventOdds = async (eventId) => {
  try {
    const oddsRes = await axios.get(`${PLACARPRO_API_URL}/odds/${eventId}`, { timeout: 15000 });
    return oddsRes.data?.data || null;
  } catch (err) {
    console.warn(`Nao foi possivel buscar odds para o evento ${eventId}:`, err.message);
    return null;
  }
};

const buildFallbackOddsFromOddsData = (oddsData) => flattenOddsChoices(oddsData)
  .slice(0, 8)
  .map((choice) => ({
    market: choice.marketName || 'Odds',
    recommendation: choice.choiceName || 'Entrada',
    odd: choice.decimalOdd,
  }));

const enrichEventsWithOdds = async (events = [], limit = 100) => {
  const candidates = events.slice(0, limit);

  const enriched = await Promise.all(candidates.map(async (event) => {
    const oddsData = await fetchEventOdds(event.id);
    const fallbackOdds = buildFallbackOddsFromOddsData(oddsData);

    return {
      ...event,
      fallbackOdds,
      hasRealOdds: fallbackOdds.some((item) => Number(item.odd) > 1),
    };
  }));

  return [
    ...enriched.filter((event) => event.hasRealOdds),
    ...enriched.filter((event) => !event.hasRealOdds),
    ...events.slice(limit),
  ];
};

const fetchDailyAnalysis = async () => {
  let events = [];
  let eligibleEvents = [];
  const fetchErrors = [];

  for (const offset of [0, 1, 2]) {
    const date = getLocalDateKeyOffset(offset);

    try {
      const matchesRes = await axios.get(`${PLACARPRO_API_URL}/scheduled-matches?date=${date}`, { timeout: 60000 }); ///////////
      const upstreamStatus = Number(matchesRes.data?.status || matchesRes.status);

      if (upstreamStatus >= 400) {
        throw new Error(`scraper retornou status ${upstreamStatus}`);
      }

      events = matchesRes.data.data || [];
      eligibleEvents = offset === 0 ? filterEligibleDailyEvents(events) : filterUpcomingEvents(events);

      if (eligibleEvents.length > 0) break;
    } catch (err) {
      fetchErrors.push(`${date}: ${err.message}`);
      console.warn(`Nao foi possivel buscar jogos de ${date} para a aposta do dia:`, err.message);
    }
  }

  if (eligibleEvents.length === 0) {
    if (fetchErrors.length > 0) {
      throw new Error(`Nao foi possivel buscar jogos para gerar entradas (${fetchErrors.join(' | ')})`);
    }

    return { selectedEvents: [], analysisResult: null };
  }

  const oddsAwareEvents = await enrichEventsWithOdds(eligibleEvents);
  const selectedEvents = oddsAwareEvents.slice(0, PREMIUM_ENTRY_LIMIT);

  try {
    const analyses = await Promise.all(selectedEvents.map(async (event) => {
      try {
        const analysisRes = await axios.get(
          `${PLACARPRO_API_URL}/analysis/${event.id}?includeOdds=false&useOddsFallback=false`,
          { timeout: DAILY_PICK_ANALYSIS_TIMEOUT_MS }
        );
        const analysis = analysisRes.data?.result;
        const oddsData = await fetchEventOdds(event.id);
        const enrichedAnalysis = enrichAnalysisWithOdds(analysis, oddsData);

        if (!hasRealOddEntry(enrichedAnalysis, [event])) {
          console.warn(`Analise da IA para o evento ${event.id} veio sem odd real casada.`);
        }

        return enrichedAnalysis;
      } catch (err) {
        console.warn(`Analise individual falhou para o evento ${event.id}:`, err.message);
        return null;
      }
    }));
    const validAnalyses = analyses.filter(Boolean).sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
    const fallbackAnalysis = validAnalyses.length ? null : buildFallbackAnalysisFromEvents(selectedEvents);

    return {
      selectedEvents,
      analysisResult: validAnalyses.length ? {
        ...validAnalyses[0],
        bestEntry: validAnalyses[0].bestEntry || validAnalyses[0],
        analyses: validAnalyses,
      } : fallbackAnalysis,
    };
  } catch (err) {
    console.warn('Analise individual dos jogos de hoje falhou:', err.message);
    return { selectedEvents, analysisResult: buildFallbackAnalysisFromEvents(selectedEvents) };
  }
};

const getDailyPickCacheKey = () => {
  return `daily-pick-v18:${process.env.SCORES_PROVIDER || '365scores'}:${getLocalDateKey()}`;
};

const isCacheFresh = (cache) => Boolean(cache?.updatedAt) && Date.now() - cache.updatedAt < DAILY_PICK_CACHE_TTL_MS;

const readPersistedDailyPick = async () => {
  const cacheKey = getDailyPickCacheKey();
  const row = await get('SELECT * FROM ai_analysis_cache WHERE cache_key = ?', [cacheKey]);

  if (!row) return null;

  try {
    return {
      cacheKey,
      data: JSON.parse(row.payload),
      updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
      error: null,
    };
  } catch (err) {
    console.warn('Cache de analise invalido no banco:', err.message);
    return null;
  }
};

const persistDailyPick = async (data) => {
  const cacheKey = getDailyPickCacheKey();
  const payload = JSON.stringify(data);
  const existing = await get('SELECT id FROM ai_analysis_cache WHERE cache_key = ?', [cacheKey]);

  if (existing) {
    await run('UPDATE ai_analysis_cache SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE cache_key = ?', [payload, cacheKey]);
  } else {
    await run('INSERT INTO ai_analysis_cache (cache_key, payload) VALUES (?, ?)', [cacheKey, payload]);
  }

  dailyPickRuntimeCache = {
    cacheKey,
    data,
    updatedAt: Date.now(),
    error: null,
  };

  return dailyPickRuntimeCache;
};

const refreshDailyPick = async () => {
  if (dailyPickRefreshPromise) return dailyPickRefreshPromise;

  dailyPickRefreshPromise = fetchDailyAnalysis()
    .then((data) => persistDailyPick(data))
    .catch((err) => {
      dailyPickRuntimeCache = {
        cacheKey: getDailyPickCacheKey(),
        data: dailyPickRuntimeCache?.data || null,
        updatedAt: dailyPickRuntimeCache?.updatedAt || 0,
        error: err.message,
      };
      console.error('Erro ao atualizar aposta do dia na API PlacarPro:', err.message);
      throw err;
    })
    .finally(() => {
      dailyPickRefreshPromise = null;
    });

  return dailyPickRefreshPromise;
};

const hasAiAnalysis = (cache) => {
  const selectedEvents = filterUpcomingEvents(cache?.data?.selectedEvents || []);
  if (!cache?.data?.analysisResult || selectedEvents.length === 0) return false;
  return selectVariedEntries(cache.data.analysisResult, selectedEvents, PREMIUM_ENTRY_LIMIT).length > 0;
};

const hasDailyPickEvents = (cache) => filterUpcomingEvents(cache?.data?.selectedEvents || []).length > 0;

const ensureDailyPick = async ({ requireAnalysis = false } = {}) => {
  const cacheKey = getDailyPickCacheKey();

  if (
    dailyPickRuntimeCache?.cacheKey === cacheKey
    && dailyPickRuntimeCache.data
    && isCacheFresh(dailyPickRuntimeCache)
    && hasDailyPickEvents(dailyPickRuntimeCache)
    && (!requireAnalysis || hasAiAnalysis(dailyPickRuntimeCache))
  ) {
    return dailyPickRuntimeCache;
  }

  const persisted = await readPersistedDailyPick();
  if (persisted?.data && isCacheFresh(persisted) && hasDailyPickEvents(persisted) && (!requireAnalysis || hasAiAnalysis(persisted))) {
    dailyPickRuntimeCache = persisted;
    return dailyPickRuntimeCache;
  }

  return refreshDailyPick();
};

const buildDailyPickPayload = (plan, cache = dailyPickRuntimeCache) => {
  const selectedEvents = filterUpcomingEvents(cache?.data?.selectedEvents || []);
  const analysisResult = selectedEvents.length ? cache?.data?.analysisResult : null;
  let apostaDoDia = null;
  let entradasPremium = [];

  if (selectedEvents.length === 0) {
    apostaDoDia = null;
  } else if (analysisResult) {
    if (plan === 'premium') {
      entradasPremium = selectVariedEntries(analysisResult, selectedEvents, PREMIUM_ENTRY_LIMIT);
      apostaDoDia = entradasPremium[0] || normalizeEntry(analysisResult.bestEntry, selectedEvents);
    } else {
      apostaDoDia = selectBasicEntry(analysisResult, selectedEvents);
    }
  } else {
    if (plan === 'premium') {
      entradasPremium = selectVariedEntries({ analyses: [] }, selectedEvents, PREMIUM_ENTRY_LIMIT);
      apostaDoDia = entradasPremium[0] || selectBasicEntry({ analyses: [] }, selectedEvents);
    } else {
      apostaDoDia = selectBasicEntry({ analyses: [] }, selectedEvents);
    }
  }

  return {
    aposta_do_dia: apostaDoDia,
    entradas_premium: entradasPremium,
    aposta_do_dia_atualizando: Boolean(dailyPickRefreshPromise),
    aposta_do_dia_erro: cache?.error || null,
    aposta_do_dia_atualizada_em: cache?.updatedAt || null,
  };
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/payments/config', authenticateToken, (_req, res) => {
  const testMode = isMercadoPagoTestMode();

  res.json({
    publicKey: process.env.MERCADOPAGO_PUBLIC_KEY || '',
    amount: PREMIUM_PLAN_PRICE_BRL,
    testMode,
    testBuyerEmail: testMode ? (String(process.env.MERCADOPAGO_TEST_BUYER_EMAIL || '').trim() || null) : null,
    allowTestApproval: process.env.ALLOW_PAYMENT_TEST_APPROVAL === 'true',
  });
});

app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Todos os campos sao obrigatorios' });
  }

  if (String(senha).length < 8) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
  }

  try {
    const existingUser = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ error: 'Email ja cadastrado' });
    }

    const hashedPassword = await bcrypt.hash(senha, 10);
    const result = await run(
      'INSERT INTO users (nome, email, senha) VALUES (?, ?, ?)',
      [nome, email, hashedPassword]
    );

    const token = jwt.sign({ id: result.id, email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: result.id, nome, email, plano: 'basico', saldo: 0, banca_inicial: 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;

  try {
    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'Usuario ou senha incorretos' });
    }

    const validPassword = await bcrypt.compare(senha, user.senha);
    if (!validPassword) {
      return res.status(400).json({ error: 'Usuario ou senha incorretos' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
      token,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        plano: user.plano,
        saldo: Number(user.saldo_atual || 0),
        banca_inicial: Number(user.banca_inicial || 0),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const [user, apostas, history] = await Promise.all([
      get('SELECT * FROM users WHERE id = ?', [req.user.id]),
      all('SELECT * FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 10', [req.user.id]),
      all('SELECT dia, saldo FROM bankroll_history WHERE user_id = ? ORDER BY id ASC', [req.user.id]),
    ]);

    if (!user) return res.sendStatus(404);

    const resolvedBets = apostas.filter((a) => ['green', 'red'].includes(a.resultado));
    const totalBets = resolvedBets.length;
    const greenBets = resolvedBets.filter((a) => a.resultado === 'green').length;
    const assertividade = totalBets > 0 ? Math.round((greenBets / totalBets) * 100) : 0;
    const saldo = Number(user.saldo_atual || 0);
    const bancaInicial = Number(user.banca_inicial || 0);
    const lucro = saldo - bancaInicial;
    const dailyPick = await ensureDailyPick({ requireAnalysis: user.plano === 'premium' }).catch((err) => ({
      cacheKey: getDailyPickCacheKey(),
      data: dailyPickRuntimeCache?.data || null,
      updatedAt: dailyPickRuntimeCache?.updatedAt || 0,
      error: err.message,
    }));

    res.json({
      saldo,
      lucro,
      assertividade,
      apostas_hoje: totalBets,
      plano: user.plano,
      banca_inicial: bancaInicial,
      stake_sugerida: Math.min(saldo, Math.max(1, saldo * 0.02)),
      ...buildDailyPickPayload(user.plano, dailyPick),
      history: history.map((h) => ({ day: String(h.dia).padStart(2, '0'), value: Number(h.saldo) })),
      apostas_recentes: apostas.map((a) => ({
        id: a.id,
        jogo: a.jogo,
        odd: Number(a.odd),
        status: mapBetStatus(a.resultado),
        valor: formatBetValue(a),
        date: a.data,
        eventId: a.event_id,
        market: a.market,
        recommendation: a.recommendation,
        valorApostado: Number(a.valor_apostado || 0),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/daily-pick', authenticateToken, async (req, res) => {
  try {
    const user = await get('SELECT plano FROM users WHERE id = ?', [req.user.id]);
    const dailyPick = await ensureDailyPick({ requireAnalysis: user?.plano === 'premium' }).catch((err) => ({
      cacheKey: getDailyPickCacheKey(),
      data: dailyPickRuntimeCache?.data || null,
      updatedAt: dailyPickRuntimeCache?.updatedAt || 0,
      error: err.message,
    }));

    res.json(buildDailyPickPayload(user?.plano || 'basico', dailyPick));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar aposta do dia' });
  }
});

app.put('/api/bankroll', authenticateToken, async (req, res) => {
  const valor = Number(req.body?.valor);

  if (!Number.isFinite(valor) || valor < 0) {
    return res.status(400).json({ error: 'Informe um valor de banca valido.' });
  }

  try {
    await run('UPDATE users SET banca_inicial = ?, saldo_atual = ? WHERE id = ?', [valor, valor, req.user.id]);
    await run('DELETE FROM bankroll_history WHERE user_id = ?', [req.user.id]);

    if (valor > 0) {
      await run('INSERT INTO bankroll_history (user_id, dia, saldo) VALUES (?, ?, ?)', [req.user.id, 1, valor]);
    }

    res.json({ success: true, banca_inicial: valor, saldo: valor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar banca' });
  }
});

app.post('/api/bets/place', authenticateToken, async (req, res) => {
  const oddNumber = Number(req.body?.odd);
  const valorApostado = Number(req.body?.valorApostado);
  const entry = req.body?.entry || {};
  const gameName = req.body?.gameName || `${entry.homeTeamName || 'Casa'} vs ${entry.awayTeamName || 'Fora'}`;

  if (!Number.isFinite(oddNumber) || oddNumber <= 1) {
    return res.status(400).json({ error: 'Odd invalida' });
  }

  if (!Number.isFinite(valorApostado) || valorApostado <= 0) {
    return res.status(400).json({ error: 'Informe o valor da entrada.' });
  }

  try {
    const user = await get('SELECT saldo_atual FROM users WHERE id = ?', [req.user.id]);
    const saldo = Number(user?.saldo_atual || 0);

    if (saldo <= 0) {
      return res.status(400).json({ error: 'Configure sua banca antes de registrar entradas.' });
    }

    if (valorApostado > saldo) {
      return res.status(400).json({ error: 'O valor da entrada nao pode ser maior que sua banca atual.' });
    }

    const eventId = entry.eventId ? String(entry.eventId) : null;
    const market = entry.market || null;
    const recommendation = entry.recommendation || null;

    const duplicate = eventId && market && recommendation
      ? await get(
        "SELECT id FROM bets WHERE user_id = ? AND event_id = ? AND market = ? AND recommendation = ? AND resultado = 'pending'",
        [req.user.id, eventId, market, recommendation]
      )
      : null;

    if (duplicate) {
      return res.status(400).json({ error: 'Voce ja registrou essa entrada e ela ainda esta pendente.' });
    }

    const novoSaldo = saldo - valorApostado;
    const countHistory = await get('SELECT COUNT(*) as c FROM bankroll_history WHERE user_id = ?', [req.user.id]);

    await run('UPDATE users SET saldo_atual = ? WHERE id = ?', [novoSaldo, req.user.id]);
    const createdBet = await run(
      'INSERT INTO bets (user_id, jogo, odd, valor_apostado, resultado, lucro_prejuizo, event_id, market, recommendation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, gameName || 'Jogo Desconhecido', oddNumber, valorApostado, 'pending', 0, eventId, market, recommendation]
    );
    await run(
      'INSERT INTO bankroll_history (user_id, dia, saldo) VALUES (?, ?, ?)',
      [req.user.id, Number(countHistory.c || 0) + 1, novoSaldo]
    );

    res.json({
      success: true,
      novoSaldo,
      stake_sugerida: Math.min(novoSaldo, Math.max(1, novoSaldo * 0.02)),
      bet: {
        id: createdBet.id,
        jogo: gameName || 'Jogo Desconhecido',
        odd: oddNumber,
        status: 'Pendente',
        valor: formatBetValue({ resultado: 'pending', lucro_prejuizo: 0, valor_apostado: valorApostado }),
        date: new Date().toISOString(),
        eventId,
        market,
        recommendation,
        valorApostado,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao registrar entrada' });
  }
});

app.post('/api/bets/resolve', authenticateToken, async (req, res) => {
  const { resultado, odd, gameName, betId } = req.body;

  if (!['green', 'red'].includes(resultado)) {
    return res.status(400).json({ error: 'Resultado invalido' });
  }

  const oddNumber = Number(odd);
  if (!betId && (!Number.isFinite(oddNumber) || oddNumber <= 1)) {
    return res.status(400).json({ error: 'Odd invalida' });
  }

  try {
    const [user, pendingBet] = await Promise.all([
      get('SELECT saldo_atual FROM users WHERE id = ?', [req.user.id]),
      betId ? get("SELECT * FROM bets WHERE id = ? AND user_id = ? AND resultado = 'pending'", [betId, req.user.id]) : Promise.resolve(null),
    ]);
    let saldo = Number(user.saldo_atual || 0);
    let valorApostado = Number(pendingBet?.valor_apostado ?? req.body?.valorApostado);
    const finalOdd = Number(pendingBet?.odd || oddNumber);
    const finalGameName = pendingBet?.jogo || gameName || 'Jogo Desconhecido';

    if (!Number.isFinite(finalOdd) || finalOdd <= 1) {
      return res.status(400).json({ error: 'Odd invalida' });
    }

    if (!Number.isFinite(valorApostado) || valorApostado <= 0) {
      valorApostado = Math.min(saldo, Math.max(1, saldo * 0.02));
    }

    if (!pendingBet) {
      valorApostado = Math.min(valorApostado, saldo);
    }

    if (valorApostado <= 0) {
      return res.status(400).json({ error: 'Configure sua banca antes de registrar apostas.' });
    }

    let lucroPrejuizo = 0;
    if (resultado === 'green') {
      lucroPrejuizo = (valorApostado * finalOdd) - valorApostado;
      saldo += pendingBet ? valorApostado * finalOdd : lucroPrejuizo;
    } else {
      lucroPrejuizo = -valorApostado;
      saldo += pendingBet ? 0 : lucroPrejuizo;
    }

    await run('UPDATE users SET saldo_atual = ? WHERE id = ?', [saldo, req.user.id]);
    if (pendingBet) {
      await run(
        'UPDATE bets SET resultado = ?, lucro_prejuizo = ? WHERE id = ? AND user_id = ?',
        [resultado, lucroPrejuizo, pendingBet.id, req.user.id]
      );
    } else {
      await run(
        'INSERT INTO bets (user_id, jogo, odd, valor_apostado, resultado, lucro_prejuizo) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, finalGameName, finalOdd, valorApostado, resultado, lucroPrejuizo]
      );
    }

    const countHistory = await get('SELECT COUNT(*) as c FROM bankroll_history WHERE user_id = ?', [req.user.id]);
    await run(
      'INSERT INTO bankroll_history (user_id, dia, saldo) VALUES (?, ?, ?)',
      [req.user.id, Number(countHistory.c || 0) + 1, saldo]
    );

    res.json({
      success: true,
      novoSaldo: saldo,
      stake_sugerida: Math.min(saldo, Math.max(1, saldo * 0.02)),
      bet: pendingBet ? {
        id: pendingBet.id,
        jogo: finalGameName,
        odd: Number(finalOdd),
        status: mapBetStatus(resultado),
        valor: formatBetValue({ resultado, lucro_prejuizo: lucroPrejuizo, valor_apostado: valorApostado }),
        date: pendingBet.data,
        eventId: pendingBet.event_id,
        market: pendingBet.market,
        recommendation: pendingBet.recommendation,
        valorApostado,
      } : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao resolver aposta' });
  }
});

app.post('/api/payments/checkout', authenticateToken, async (req, res) => {
  try {
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Configure MERCADOPAGO_ACCESS_TOKEN no backend para gerar checkout real.' });
    }

    const externalId = `premium-${req.user.id}-${Date.now()}`;
    const notificationUrl = getPaymentNotificationUrl();
    const user = await get('SELECT email, nome FROM users WHERE id = ?', [req.user.id]);
    const paymentPayload = {
      transaction_amount: PREMIUM_PLAN_PRICE_BRL,
      description: process.env.MERCADOPAGO_PREMIUM_PRODUCT_DESCRIPTION || 'Acesso premium ao PlacarPro',
      payment_method_id: 'pix',
      external_reference: externalId,
      payer: {
        email: user?.email || req.user.email,
        first_name: user?.nome || undefined,
      },
      metadata: {
        userId: String(req.user.id),
        plan: 'premium',
        external_id: externalId,
      },
    };

    if (notificationUrl) {
      paymentPayload.notification_url = notificationUrl;
    }

    const payment = await mercadoPagoRequest(
      'POST',
      '/v1/payments',
      paymentPayload,
      null,
      { 'X-Idempotency-Key': crypto.randomUUID() }
    );
    const transactionData = payment?.point_of_interaction?.transaction_data || {};

    await run(
      'INSERT INTO payment_sessions (user_id, checkout_id, external_id, status, plan, amount, checkout_url, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, payment.id, externalId, payment.status || 'pending', 'premium', PREMIUM_PLAN_PRICE, transactionData.ticket_url, JSON.stringify(payment)]
    );

    res.json({
      paymentMethod: 'pix',
      paymentId: payment.id,
      checkoutId: payment.id,
      externalId,
      status: payment.status,
      checkoutUrl: transactionData.ticket_url,
      pix: {
        qrCode: transactionData.qr_code,
        qrCodeBase64: transactionData.qr_code_base64,
        ticketUrl: transactionData.ticket_url,
        expiresAt: payment.date_of_expiration || null,
      },
    });
  } catch (err) {
    const details = getMercadoPagoErrorMessage(err);
    console.error('Erro no Mercado Pago:', err.response?.data || err.message);
    res.status(500).json({
      error: `Erro ao processar pagamento com Mercado Pago: ${details}`,
      details,
    });
  }
});

app.post('/api/payments/card', authenticateToken, async (req, res) => {
  const token = String(req.body?.token || '');
  const paymentMethodId = String(req.body?.paymentMethodId || req.body?.payment_method_id || '');
  const issuerId = req.body?.issuerId || req.body?.issuer_id;
  const installments = Number(req.body?.installments || 1);
  const identificationType = req.body?.identificationType || req.body?.identification?.type;
  const identificationNumber = req.body?.identificationNumber || req.body?.identification?.number;
  const cardholderEmail = req.body?.cardholderEmail;

  if (!token || !paymentMethodId || !Number.isFinite(installments) || installments < 1) {
    return res.status(400).json({ error: 'Dados do cartao incompletos.' });
  }

  try {
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Configure MERCADOPAGO_ACCESS_TOKEN no backend para gerar checkout real.' });
    }

    const externalId = `premium-card-${req.user.id}-${Date.now()}`;
    const notificationUrl = getPaymentNotificationUrl();
    const user = await get('SELECT email, nome FROM users WHERE id = ?', [req.user.id]);
    const payer = {
      email: getMercadoPagoPayerEmail(cardholderEmail, user?.email || req.user.email),
    };

    if (identificationType && identificationNumber) {
      payer.identification = {
        type: identificationType,
        number: String(identificationNumber).replace(/\D/g, ''),
      };
    }

    const paymentPayload = {
      transaction_amount: PREMIUM_PLAN_PRICE_BRL,
      description: process.env.MERCADOPAGO_PREMIUM_PRODUCT_DESCRIPTION || 'Acesso premium ao PlacarPro',
      token,
      installments,
      payment_method_id: paymentMethodId,
      external_reference: externalId,
      payer,
      metadata: {
        userId: String(req.user.id),
        plan: 'premium',
        external_id: externalId,
      },
    };

    if (issuerId && String(issuerId).toLowerCase() !== 'undefined') {
      paymentPayload.issuer_id = issuerId;
    }
    if (notificationUrl) paymentPayload.notification_url = notificationUrl;

    console.info('Payload Mercado Pago cartao:', sanitizeMercadoPagoPayload(paymentPayload));

    const payment = await mercadoPagoRequest(
      'POST',
      '/v1/payments',
      paymentPayload,
      null,
      { 'X-Idempotency-Key': crypto.randomUUID() }
    );

    await run(
      'INSERT INTO payment_sessions (user_id, checkout_id, external_id, status, plan, amount, checkout_url, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, payment.id, externalId, payment.status || 'pending', 'premium', PREMIUM_PLAN_PRICE, null, JSON.stringify(payment)]
    );

    await activatePremiumFromPayment(payment);

    res.json({
      paymentMethod: 'card',
      paymentId: payment.id,
      externalId,
      status: payment.status,
      statusDetail: payment.status_detail,
      premium: isPaidStatus(payment.status),
    });
  } catch (err) {
    const details = getMercadoPagoErrorMessage(err);
    const mpDetails = getMercadoPagoErrorDetails(err);
    console.error('Erro no pagamento por cartao Mercado Pago:', {
      response: err.response?.data || err.message,
      requestId: err.response?.headers?.['x-request-id'] || err.response?.headers?.['x-correlation-id'],
      status: err.response?.status,
    });
    res.status(500).json({
      error: `Erro ao processar cartao com Mercado Pago: ${details}`,
      details,
      mercadoPago: mpDetails,
    });
  }
});

app.get('/api/payments/checkout/:checkoutId/confirm', authenticateToken, async (req, res) => {
  try {
    const session = await get(
      'SELECT * FROM payment_sessions WHERE checkout_id = ? AND user_id = ?',
      [req.params.checkoutId, req.user.id]
    );

    if (!session) return res.status(404).json({ error: 'Checkout nao encontrado' });

    const paymentId = req.query.payment_id || req.query.collection_id;
    const payment = paymentId
      ? await getMercadoPagoPaymentById(paymentId)
      : await findMercadoPagoPaymentByExternalId(session.external_id);

    if (payment) {
      await activatePremiumFromPayment(payment);
    }

    const status = payment?.status || session.status;
    res.json({ success: true, status, premium: isPaidStatus(status) });
  } catch (err) {
    console.error('Erro ao confirmar checkout:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao confirmar pagamento' });
  }
});

app.get('/api/payments/session/:externalId/confirm', authenticateToken, async (req, res) => {
  try {
    const session = await get(
      'SELECT * FROM payment_sessions WHERE external_id = ? AND user_id = ?',
      [req.params.externalId, req.user.id]
    );

    if (!session) return res.status(404).json({ error: 'Sessao de pagamento nao encontrada' });

    const paymentId = req.query.payment_id || req.query.collection_id;
    const payment = paymentId
      ? await getMercadoPagoPaymentById(paymentId)
      : await findMercadoPagoPaymentByExternalId(session.external_id);

    if (payment) {
      await activatePremiumFromPayment(payment);
    }

    const status = payment?.status || session.status;
    res.json({ success: true, status, premium: isPaidStatus(status) });
  } catch (err) {
    console.error('Erro ao confirmar sessao:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao confirmar pagamento' });
  }
});

app.post('/api/payments/session/:externalId/simulate-approval', authenticateToken, async (req, res) => {
  if (process.env.ALLOW_PAYMENT_TEST_APPROVAL !== 'true') {
    return res.status(403).json({ error: 'Modo de aprovacao de teste desativado.' });
  }

  try {
    const session = await get(
      'SELECT * FROM payment_sessions WHERE external_id = ? AND user_id = ?',
      [req.params.externalId, req.user.id]
    );

    if (!session) return res.status(404).json({ error: 'Sessao de pagamento nao encontrada' });

    const simulatedPayment = {
      id: session.checkout_id,
      status: 'approved',
      status_detail: 'test_approved',
      external_reference: session.external_id,
      metadata: {
        userId: String(req.user.id),
        plan: 'premium',
        external_id: session.external_id,
      },
      simulated: true,
      simulated_at: new Date().toISOString(),
    };

    await activatePremiumFromPayment(simulatedPayment);

    res.json({
      success: true,
      premium: true,
      status: 'approved',
      statusDetail: 'test_approved',
    });
  } catch (err) {
    console.error('Erro ao simular aprovacao:', err);
    res.status(500).json({ error: 'Erro ao simular aprovacao de pagamento' });
  }
});

app.post('/api/payments/webhook', async (req, res) => {
  try {
    if (process.env.MERCADOPAGO_WEBHOOK_SECRET && req.query.webhookSecret !== process.env.MERCADOPAGO_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const topic = req.query.topic || req.query.type || req.body?.type;
    const paymentId = req.query.id || req.query['data.id'] || req.body?.data?.id;

    if (String(topic).includes('payment') && paymentId) {
      const payment = await getMercadoPagoPaymentById(paymentId);
      await activatePremiumFromPayment(payment);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erro ao processar webhook:', err);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Porta ${PORT} ja esta em uso. Feche a API antiga ou rode: npm run start:local`);
    process.exit(1);
  }

  console.error('Erro ao iniciar servidor:', err.message);
  process.exitCode = 1;
});
