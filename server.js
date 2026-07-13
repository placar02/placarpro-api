const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const { ready: databaseReady, run, get, all } = require('./db');
const adminRoutes = require('./routes/admin');

const app = express();
app.disable('x-powered-by');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-betleverage-key-2026';
const FRONTEND_URL = process.env.FRONTEND_URL ;
const PLACARPRO_API_URL = process.env.PLACARPRO_API_URL ;
const MERCADOPAGO_API_URL = 'https://api.mercadopago.com';
const BASIC_MAX_ODD = 1.5;
const PREMIUM_ENTRY_LIMIT = 5;
const PREMIUM_PLAN_PRICE = Number(process.env.PREMIUM_PLAN_PRICE_CENTS || 2000);
const PREMIUM_PLAN_PRICE_BRL = Number((PREMIUM_PLAN_PRICE / 100).toFixed(2));
const PREMIUM_PRODUCT_EXTERNAL_ID = process.env.MERCADOPAGO_PREMIUM_PRODUCT_EXTERNAL_ID || 'placarpro-premium';
const DAILY_PICK_ANALYSIS_TIMEOUT_MS = Number(process.env.DAILY_PICK_ANALYSIS_TIMEOUT_MS || 120000);
const DAILY_PICK_ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.DAILY_PICK_ANALYSIS_CONCURRENCY || 1));
const DAILY_PICK_FAST_TIMEOUT_MS = Number(process.env.DAILY_PICK_FAST_TIMEOUT_MS || 20000);
const SCRAPER_RETRY_ATTEMPTS = Math.max(1, Number(process.env.SCRAPER_RETRY_ATTEMPTS || 3));
const SCRAPER_RETRY_DELAY_MS = Math.max(250, Number(process.env.SCRAPER_RETRY_DELAY_MS || 2500));
const DAILY_PICK_CACHE_VERSION = process.env.DAILY_PICK_CACHE_VERSION || 'v24';
const DAILY_PICK_GENERATION_STALE_MS = Number(process.env.DAILY_PICK_GENERATION_STALE_MS || 45 * 60 * 1000);
const DAILY_PICK_READ_ONLY = process.env.DAILY_PICK_READ_ONLY === 'true';
const DAILY_PICK_SCHEDULER_ENABLED = !DAILY_PICK_READ_ONLY && process.env.DAILY_PICK_SCHEDULER_ENABLED !== 'false';
const DAILY_PICK_ON_DEMAND_ENABLED = process.env.DAILY_PICK_ON_DEMAND_ENABLED === 'true';
const DAILY_PICK_SCHEDULER_INTERVAL_MS = Number(process.env.DAILY_PICK_SCHEDULER_INTERVAL_MS || 10 * 60 * 1000);
const DAILY_PICK_SCHEDULER_START_DELAY_MS = Number(process.env.DAILY_PICK_SCHEDULER_START_DELAY_MS || 1000);
const DAILY_PICK_SCHEDULER_MODES = (process.env.DAILY_PICK_SCHEDULER_MODES || 'prelive')
  .split(',')
  .map((mode) => String(mode || '').toLowerCase() === 'live' ? 'live' : 'prelive')
  .filter((mode, index, modes) => modes.indexOf(mode) === index);
const ENABLE_ODDS_ENRICHMENT = process.env.ENABLE_ODDS_ENRICHMENT === 'true';

const dailyPickRefreshPromises = new Map();
const dailyPickRuntimeCaches = new Map();

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

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.sendStatus(403);
    try {
      const account = await get('SELECT id, email, role, plano, status FROM users WHERE id = ?', [user.id]);
      if (!account || account.status === 'blocked') return res.status(403).json({ error: 'Acesso negado.' });
      if (user.sid) {
        const session = await get('SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND revoked = FALSE AND expires_at > CURRENT_TIMESTAMP', [user.sid, user.id]);
        if (!session) return res.status(403).json({ error: 'Sessao expirada ou encerrada.' });
        await run('UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [user.sid]);
      }
      req.user = { ...user, role: account.role || (account.plano === 'premium' ? 'premium' : 'free') };
      return next();
    } catch (databaseError) {
      return next(databaseError);
    }
  });
};

const requirePremium = async (req, res, next) => {
  try {
    const user = await get('SELECT plano FROM users WHERE id = ?', [req.user.id]);
    const subscription = await get("SELECT id, ends_at FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [req.user.id]);

    if (!user) return res.sendStatus(404);
    if (subscription?.ends_at && new Date(subscription.ends_at).getTime() <= Date.now()) {
      await run("UPDATE subscriptions SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [subscription.id]);
      await run("UPDATE users SET plano = 'basico', role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'free' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [req.user.id]);
      return res.status(403).json({ error: 'Sua assinatura expirou.', code: 'SUBSCRIPTION_EXPIRED' });
    }
    if (user.plano !== 'premium') {
      return res.status(403).json({
        error: 'Esta funcionalidade e exclusiva para usuarios Premium.',
        code: 'PREMIUM_REQUIRED',
      });
    }

    next();
  } catch (err) {
    console.error('Erro ao validar plano Premium:', err);
    res.status(500).json({ error: 'Nao foi possivel validar seu plano.' });
  }
};

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth' }));
app.use('/api/payments', rateLimit({ windowMs: 60 * 1000, max: 40, keyPrefix: 'payments' }));
app.use('/api/admin', adminRoutes);

app.get('/api/settings/public', async (_req, res) => {
  try {
    const settings = await get(`SELECT system_name, logo_url, favicon_url, primary_color, secondary_color,
      contact_email, contact_phone, social_links, home_text, user_message, maintenance_mode
      FROM app_settings WHERE id = 1`);
    res.json(settings || {});
  } catch (_error) {
    res.json({ system_name: 'PlacarPro', primary_color: '#00E676', secondary_color: '#1A1A1A' });
  }
});

app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth') || req.path === '/api/health' || req.path === '/api/settings/public' || req.path === '/api/payments/config' || req.path === '/api/payments/webhook') return next();
  try {
    const settings = await get('SELECT maintenance_mode, user_message FROM app_settings WHERE id = 1');
    if (settings?.maintenance_mode) return res.status(503).json({ error: settings.user_message || 'Sistema temporariamente em manutencao.', code: 'MAINTENANCE_MODE' });
    return next();
  } catch (error) { return next(error); }
});

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

const sanitizeProviderText = (value, fallback = '') => {
  const sanitized = String(value || '')
    .replace(/\bogol\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return sanitized || fallback;
};

const getTeamImageUrl = (team) => {
  const value = team?.imageUrl || team?.imageSmall || team?.image || null;
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (String(value).startsWith('/') && PLACARPRO_API_URL) {
    return `${String(PLACARPRO_API_URL).replace(/\/$/, '')}${value}`;
  }
  return value;
};

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

const isFallbackEntry = (entry) => {
  const text = normalizeOddText(`${entry?.market || ''} ${entry?.recommendation || ''} ${entry?.rationale || ''}`);
  const oddsSource = String(entry?.meta?.oddsMatchedBy || entry?.bestEntry?.meta?.oddsMatchedBy || '');
  return entry?.analysisSource === 'fallback-provider'
    || oddsSource === 'fallback-provider'
    || oddsSource === 'unavailable'
    || text.includes('fallback de calendario')
    || text.includes('acompanhar mercado antes da entrada');
};

const isUsableAnalysis = (analysis) => {
  if (!analysis || analysis.analysisSource === 'fallback-provider') return false;
  if (String(analysis.recommendation || '').toLowerCase() === 'error') return false;
  if (Number(analysis.confidence || 0) <= 0) return false;
  return true;
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

  const explicitMinute = Number(event?.liveMinute || event?.currentTime || event?.time?.current || event?.time?.minute || 0);
  if (Number.isFinite(explicitMinute) && explicitMinute > 0) return Math.min(Math.floor(explicitMinute), 130);

  const periodStart = Number(event?.time?.currentPeriodStartTimestamp || event?.currentPeriodStartTimestamp || getEventStartTimestamp(event) || 0);
  if (!periodStart) return null;
  const elapsed = Math.max(1, Math.floor((Date.now() / 1000 - periodStart) / 60));
  const max = Number(event?.time?.max || 90);
  const extra = Number(event?.time?.extra || 0);
  return Math.min(elapsed, Math.max(max + extra, 130));
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

const normalizeMatchMode = (value) => String(value || '').toLowerCase() === 'live' ? 'live' : 'prelive';

const filterLiveEvents = (events = []) => events
  .filter((event) => event?.id && isLiveStatus(event) && !isFinishedStatus(event))
  .sort((a, b) => getEventStartTimestamp(a) - getEventStartTimestamp(b));

const filterEventsForMode = (events = [], mode = 'prelive') => {
  return normalizeMatchMode(mode) === 'live' ? filterLiveEvents(events) : filterUpcomingEvents(events);
};

const normalizeEntry = (entry, events = []) => {
  if (!entry) return null;
  if (!entry.recommendation && !entry.market && !entry.bestEntry) return null;

  const entryEventId = entry.eventId || (events.length === 1 ? events[0]?.id : null);
  const matchedEvent = events.find((event) => String(event.id) === String(entryEventId));
  const fullRationale = String(entry.rationale || '').trim();
  const liveMinute = getLiveMinute(matchedEvent) || entry.liveMinute || null;
  const statusType = String(matchedEvent?.status?.type || entry.status?.type || '').toLowerCase();

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
    homeTeamName: sanitizeProviderText(matchedEvent?.homeTeam?.name || entry.homeTeamName, 'Casa'),
    awayTeamName: sanitizeProviderText(matchedEvent?.awayTeam?.name || entry.awayTeamName, 'Fora'),
    homeTeamImageUrl: getTeamImageUrl(matchedEvent?.homeTeam) || entry.homeTeamImageUrl || entry.homeTeam?.imageUrl || null,
    awayTeamImageUrl: getTeamImageUrl(matchedEvent?.awayTeam) || entry.awayTeamImageUrl || entry.awayTeam?.imageUrl || null,
    tournamentName: sanitizeProviderText(matchedEvent?.tournament?.name || entry.tournamentName, ''),
    startTimestamp: matchedEvent?.startTimestamp || entry.startTimestamp || null,
    status: matchedEvent?.status || entry.status || null,
    liveMinute,
    matchMode: ['inprogress', 'live'].includes(statusType) ? 'live' : 'prelive',
    liveContext: ['inprogress', 'live'].includes(statusType)
      ? `Ao vivo${liveMinute ? ` - ${liveMinute}'` : ''}`
      : null,
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
    .filter((entry) => eventIds.has(String(entry.eventId)))
    .filter((entry) => !isFallbackEntry(entry));
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
  const candidates = expandRecommendations(analysisResult, events)
    .filter((entry) => !isFallbackEntry(entry));
  const allowedEntry = candidates.find((entry) => entry.odd && entry.odd > 1 && entry.odd <= BASIC_MAX_ODD);

  if (allowedEntry) return allowedEntry;

  return candidates[0] || null;
};

const buildBasicEntryFromEvent = (event) => {
  if (!event?.id) return null;
  const homeTeamName = sanitizeProviderText(event.homeTeam?.name, 'Casa');
  const awayTeamName = sanitizeProviderText(event.awayTeam?.name, 'Fora');
  const tournamentName = sanitizeProviderText(event.tournament?.name, '');
  const timestamp = getEventStartTimestamp(event);
  const matchTime = timestamp
    ? new Intl.DateTimeFormat('pt-BR', {
      timeZone: process.env.DAILY_PICK_TIMEZONE || 'America/Sao_Paulo',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp * 1000))
    : 'horario a confirmar';
  const isLive = isLiveStatus(event);
  const statusText = isLive ? 'ao vivo' : `marcada para ${matchTime}`;
  const competitionText = tournamentName ? ` pelo ${tournamentName}` : '';
  const summary = `${homeTeamName} e ${awayTeamName} se enfrentam${competitionText}, em partida ${statusText}. O plano basico mostra a previa do confronto; a leitura completa com IA, mercados e odds reais fica disponivel no Premium.`;

  return normalizeEntry({
    eventId: event.id,
    market: 'Previa',
    recommendation: 'Previa da partida',
    confidence: 0,
    rationale: summary,
    analysisSummary: summary,
    homeTeamName,
    awayTeamName,
    homeTeamImageUrl: getTeamImageUrl(event.homeTeam),
    awayTeamImageUrl: getTeamImageUrl(event.awayTeam),
    tournamentName,
    startTimestamp: timestamp || null,
    status: event.status || null,
    keyFactors: [
      tournamentName ? `Competicao: ${tournamentName}` : null,
      `Horario: ${matchTime}`,
      'Analise completa reservada ao plano Premium.',
    ].filter(Boolean),
    dataSupport: ['Jogo localizado na agenda esportiva do dia.', 'Confronto e horario confirmados pelo calendario.'],
    warningSigns: ['Sem recomendacao de entrada no plano basico.', 'Odds reais e leitura da IA nao sao exibidas nesta previa.'],
    riskAnalysis: 'Use esta previa apenas para acompanhar o jogo. Para decidir entradas, consulte a analise completa com IA e odds reais no Premium.',
  }, [event]);
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
    const [plan, settings] = await Promise.all([
      session.plan_id ? get('SELECT billing_period FROM plans WHERE id = ?', [session.plan_id]) : null,
      get('SELECT max_accesses FROM payment_settings WHERE id = 1'),
    ]);
    const periodDays = { monthly: 30, quarterly: 90, yearly: 365 }[plan?.billing_period];
    const endsAt = periodDays ? new Date(Date.now() + periodDays * 86400000) : null;
    await run("UPDATE users SET plano = 'premium', role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'premium' END, plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [session.plan_id, session.user_id]);
    const activeSubscription = await get("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [session.user_id]);
    if (!activeSubscription) {
      await run('INSERT INTO subscriptions (user_id, plan_id, status, ends_at, access_limit) VALUES (?, ?, ?, ?, ?)', [session.user_id, session.plan_id, 'active', endsAt, settings?.max_accesses || 1]);
    } else {
      await run('UPDATE subscriptions SET plan_id = ?, ends_at = ?, access_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [session.plan_id, endsAt, settings?.max_accesses || 1, activeSubscription.id]);
    }
    if (session.coupon_id && !session.coupon_redeemed) {
      const redeemed = await run('UPDATE payment_sessions SET coupon_redeemed = TRUE WHERE id = ? AND coupon_redeemed = FALSE', [session.id]);
      if (redeemed.changes) await run('UPDATE coupons SET uses_count = uses_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [session.coupon_id]);
    }
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableScraperError = (err) => [429, 502, 503, 504].includes(Number(err.response?.status));

const getPublicDailyPickError = (error) => {
  const text = String(error || '');
  if (!text) return null;
  if (/status code (429|502|503|504)|request failed|timeout|econnreset|enotfound/i.test(text)) {
    return 'Agenda temporariamente indisponivel. Estamos tentando reconectar ao servico de jogos.';
  }
  return text;
};

const scraperGet = async (path, options = {}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= SCRAPER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await axios.get(`${PLACARPRO_API_URL}${path}`, options);
    } catch (err) {
      lastError = err;
      if (!isRetryableScraperError(err) || attempt >= SCRAPER_RETRY_ATTEMPTS) break;

      console.warn(
        `Scraper respondeu ${err.response?.status} em ${path}. Tentando novamente (${attempt + 1}/${SCRAPER_RETRY_ATTEMPTS})...`
      );
      await wait(SCRAPER_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
};

const fetchEventOdds = async (eventId) => {
  try {
    const oddsRes = await scraperGet(`/odds/${eventId}`, { timeout: 15000 });
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

const analyzeDailyEvents = async (events = []) => {
  const analyses = [];
  let index = 0;

  async function worker() {
    while (index < events.length) {
      const currentIndex = index;
      index += 1;
      const event = events[currentIndex];

      try {
        const analysisRes = await scraperGet(
          `/analysis/${event.id}?includeOdds=false&useOddsFallback=false`,
          { timeout: DAILY_PICK_ANALYSIS_TIMEOUT_MS }
        );
        const analysis = analysisRes.data?.result;
        const oddsData = ENABLE_ODDS_ENRICHMENT ? await fetchEventOdds(event.id) : null;
        const enrichedAnalysis = oddsData ? enrichAnalysisWithOdds(analysis, oddsData) : analysis;

        if (ENABLE_ODDS_ENRICHMENT && !hasRealOddEntry(enrichedAnalysis, [event])) {
          console.warn(`Analise da IA para o evento ${event.id} veio sem odd real casada.`);
        }

        analyses[currentIndex] = enrichedAnalysis;
      } catch (err) {
        console.warn(`Analise individual falhou para o evento ${event.id}:`, err.message);
        analyses[currentIndex] = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DAILY_PICK_ANALYSIS_CONCURRENCY, events.length) }, () => worker())
  );

  return analyses.filter(Boolean);
};

const fetchDailyCandidateEvents = async (mode = 'prelive', timeoutMs = 60000) => {
  const matchMode = normalizeMatchMode(mode);
  let events = [];
  let eligibleEvents = [];
  const fetchErrors = [];

  if (matchMode === 'live') {
    try {
      const matchesRes = await scraperGet('/live-matches', { timeout: timeoutMs });
      const upstreamStatus = Number(matchesRes.data?.status || matchesRes.status);

      if (upstreamStatus >= 400) {
        throw new Error(`scraper retornou status ${upstreamStatus}`);
      }

      events = matchesRes.data.data || [];
      eligibleEvents = filterLiveEvents(events);
    } catch (err) {
      fetchErrors.push(`live: ${err.message}`);
      console.warn('Nao foi possivel buscar jogos ao vivo para a aposta do dia:', err.message);
      if (isRetryableScraperError(err)) throw err;
    }
  }

  for (const offset of matchMode === 'live' ? [] : [0, 1, 2]) {
    const date = getLocalDateKeyOffset(offset);

    try {
      const matchesRes = await scraperGet(`/scheduled-matches?date=${date}`, { timeout: timeoutMs }); ///////////
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
      if (isRetryableScraperError(err)) throw err;
    }
  }

  if (eligibleEvents.length === 0) {
    if (fetchErrors.length > 0) {
      throw new Error(`Nao foi possivel buscar jogos para gerar entradas (${fetchErrors.join(' | ')})`);
    }

    return { matchMode, eligibleEvents: [] };
  }

  return { matchMode, eligibleEvents };
};

const fetchDailyEventsOnly = async (mode = 'prelive') => {
  const { matchMode, eligibleEvents } = await fetchDailyCandidateEvents(mode, DAILY_PICK_FAST_TIMEOUT_MS);
  return {
    matchMode,
    selectedEvents: eligibleEvents.slice(0, PREMIUM_ENTRY_LIMIT),
    analysisResult: null,
  };
};

const getFastDailyPick = async (mode = 'prelive', state = null) => {
  const matchMode = normalizeMatchMode(mode);
  const cacheKey = getDailyPickCacheKey(matchMode);
  const cached = dailyPickRuntimeCaches.get(matchMode);

  if (cached?.cacheKey === cacheKey && cached?.data && hasDailyPickEvents(cached)) {
    return cached;
  }

  const data = await fetchDailyEventsOnly(matchMode);
  const fastCache = {
    cacheKey,
    data,
    updatedAt: Date.now(),
    error: state?.status === 'failed' ? state.error : null,
    status: state?.status || 'generating',
  };
  dailyPickRuntimeCaches.set(matchMode, fastCache);
  return fastCache;
};

const fetchDailyAnalysis = async (mode = 'prelive') => {
  const { matchMode, eligibleEvents } = await fetchDailyCandidateEvents(mode);

  if (eligibleEvents.length === 0) {
    return { matchMode, selectedEvents: [], analysisResult: null };
  }

  const rankedEvents = ENABLE_ODDS_ENRICHMENT
    ? await enrichEventsWithOdds(eligibleEvents)
    : eligibleEvents;
  const selectedEvents = rankedEvents.slice(0, PREMIUM_ENTRY_LIMIT);

  try {
    const analyses = await analyzeDailyEvents(selectedEvents);
    const validAnalyses = analyses.filter(isUsableAnalysis).sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));

    return {
      matchMode,
      selectedEvents,
      analysisResult: validAnalyses.length ? {
        ...validAnalyses[0],
        bestEntry: validAnalyses[0].bestEntry || validAnalyses[0],
        analyses: validAnalyses,
      } : null,
    };
  } catch (err) {
    console.warn('Analise individual dos jogos de hoje falhou:', err.message);
    return { matchMode, selectedEvents, analysisResult: null };
  }
};

const getDailyPickCacheKey = (mode = 'prelive') => {
  return `daily-pick-${DAILY_PICK_CACHE_VERSION}:${normalizeMatchMode(mode)}:${process.env.SCORES_PROVIDER || '365scores'}:${getLocalDateKey()}`;
};

const getDailyPickProvider = () => process.env.SCORES_PROVIDER || '365scores';

const parseDailyPickPayload = (payload) => {
  if (!payload) return null;
  if (typeof payload === 'string') return JSON.parse(payload);
  return payload;
};

const mapDailyPickPublication = (row, mode = 'prelive') => {
  if (!row) return null;
  const matchMode = normalizeMatchMode(row.match_mode || mode);
  return {
    cacheKey: getDailyPickCacheKey(matchMode),
    data: parseDailyPickPayload(row.payload),
    updatedAt: row.generated_at
      ? new Date(row.generated_at).getTime()
      : row.updated_at
        ? new Date(row.updated_at).getTime()
        : Date.now(),
    error: row.error || null,
    status: row.status || 'published',
  };
};

const readPublishedDailyPick = async (mode = 'prelive') => {
  const matchMode = normalizeMatchMode(mode);
  const row = await get(
    `SELECT * FROM daily_analysis_publications
     WHERE analysis_date = ? AND match_mode = ? AND provider = ? AND cache_version = ? AND status = 'published'
     LIMIT 1`,
    [getLocalDateKey(), matchMode, getDailyPickProvider(), DAILY_PICK_CACHE_VERSION]
  );

  try {
    return mapDailyPickPublication(row, matchMode);
  } catch (err) {
    console.warn('Publicacao diaria de analise invalida no banco:', err.message);
    return null;
  }
};

const readDailyPickPublicationState = async (mode = 'prelive') => {
  const matchMode = normalizeMatchMode(mode);
  return get(
    `SELECT id, status, error, updated_at, generated_at FROM daily_analysis_publications
     WHERE analysis_date = ? AND match_mode = ? AND provider = ? AND cache_version = ?
     LIMIT 1`,
    [getLocalDateKey(), matchMode, getDailyPickProvider(), DAILY_PICK_CACHE_VERSION]
  );
};

const persistLegacyDailyPickCache = async (data, mode = 'prelive') => {
  const cacheKey = getDailyPickCacheKey(mode);
  const payload = JSON.stringify(data);
  const existing = await get('SELECT id FROM ai_analysis_cache WHERE cache_key = ?', [cacheKey]);

  if (existing) {
    await run('UPDATE ai_analysis_cache SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE cache_key = ?', [payload, cacheKey]);
  } else {
    await run('INSERT INTO ai_analysis_cache (cache_key, payload) VALUES (?, ?)', [cacheKey, payload]);
  }
};

const claimDailyPickGeneration = async (mode = 'prelive') => {
  const matchMode = normalizeMatchMode(mode);
  const token = crypto.randomUUID();
  const params = [getLocalDateKey(), matchMode, getDailyPickProvider(), DAILY_PICK_CACHE_VERSION, token];

  try {
    const inserted = await get(
      `INSERT INTO daily_analysis_publications
       (analysis_date, match_mode, provider, cache_version, status, generation_token)
       VALUES (?, ?, ?, ?, 'generating', ?)
       ON CONFLICT (analysis_date, match_mode, provider, cache_version) DO NOTHING
       RETURNING id`,
      params
    );
    if (inserted?.id) return { id: inserted.id, token };
  } catch (err) {
    console.error('Erro ao iniciar publicacao diaria de analise:', err.message);
    return null;
  }

  const staleBefore = new Date(Date.now() - DAILY_PICK_GENERATION_STALE_MS).toISOString();
  const updated = await get(
    `UPDATE daily_analysis_publications
     SET status = 'generating', generation_token = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE analysis_date = ? AND match_mode = ? AND provider = ? AND cache_version = ?
       AND status <> 'published'
       AND (status <> 'generating' OR updated_at < ?)
     RETURNING id`,
    [token, getLocalDateKey(), matchMode, getDailyPickProvider(), DAILY_PICK_CACHE_VERSION, staleBefore]
  );

  return updated?.id ? { id: updated.id, token } : null;
};

const publishDailyPick = async (claim, data, mode = 'prelive') => {
  const matchMode = normalizeMatchMode(mode || data?.matchMode);
  const payload = JSON.stringify(data);
  await run(
    `UPDATE daily_analysis_publications
     SET status = 'published', payload = ?::jsonb, error = NULL, generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND generation_token = ?`,
    [payload, claim.id, claim.token]
  );
  await persistLegacyDailyPickCache(data, matchMode);
  const runtimeCache = {
    cacheKey: getDailyPickCacheKey(matchMode),
    data,
    updatedAt: Date.now(),
    error: null,
    status: 'published',
  };

  dailyPickRuntimeCaches.set(matchMode, runtimeCache);

  return runtimeCache;
};

const upsertPublishedDailyPick = async (data, mode = 'prelive') => {
  const matchMode = normalizeMatchMode(mode || data?.matchMode);
  const payload = JSON.stringify(data);

  await run(
    `INSERT INTO daily_analysis_publications
     (analysis_date, match_mode, provider, cache_version, status, payload, error, generated_at, updated_at)
     VALUES (?, ?, ?, ?, 'published', ?::jsonb, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (analysis_date, match_mode, provider, cache_version)
     DO UPDATE SET
       status = 'published',
       payload = EXCLUDED.payload,
       error = NULL,
       generation_token = NULL,
       generated_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [getLocalDateKey(), matchMode, getDailyPickProvider(), DAILY_PICK_CACHE_VERSION, payload]
  );

  await persistLegacyDailyPickCache(data, matchMode);

  const runtimeCache = {
    cacheKey: getDailyPickCacheKey(matchMode),
    data,
    updatedAt: Date.now(),
    error: null,
    status: 'published',
  };

  dailyPickRuntimeCaches.set(matchMode, runtimeCache);
  return runtimeCache;
};

const generateAndPublishDailyPick = async ({ mode = 'prelive', force = false } = {}) => {
  const matchMode = normalizeMatchMode(mode);
  if (!force) {
    const published = await readPublishedDailyPick(matchMode);
    if (published?.data && hasDailyPickEvents(published)) {
      dailyPickRuntimeCaches.set(matchMode, published);
      return { ...published, reused: true };
    }
  }

  const data = await fetchDailyAnalysis(matchMode);
  const published = await upsertPublishedDailyPick(data, matchMode);
  return { ...published, reused: false };
};

const failDailyPickPublication = async (claim, err) => {
  await run(
    `UPDATE daily_analysis_publications
     SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND generation_token = ?`,
    [err.message, claim.id, claim.token]
  );
};

const publishDailyPickIfNeeded = async (mode = 'prelive') => {
  const matchMode = normalizeMatchMode(mode);
  const currentPromise = dailyPickRefreshPromises.get(matchMode);
  if (currentPromise) return currentPromise;

  const refreshPromise = (async () => {
    const published = await readPublishedDailyPick(matchMode);
    if (published?.data && hasDailyPickEvents(published)) {
      dailyPickRuntimeCaches.set(matchMode, published);
      return published;
    }

    const claim = await claimDailyPickGeneration(matchMode);
    if (!claim) {
      return readPublishedDailyPick(matchMode);
    }

    try {
      const data = await fetchDailyAnalysis(matchMode);
      return publishDailyPick(claim, data, matchMode);
    } catch (err) {
      await failDailyPickPublication(claim, err);
      throw err;
    }
  })()
    .catch((err) => {
      const previousCache = dailyPickRuntimeCaches.get(matchMode);
      const failedCache = {
        cacheKey: getDailyPickCacheKey(matchMode),
        data: previousCache?.data || null,
        updatedAt: previousCache?.updatedAt || 0,
        error: err.message,
        status: 'failed',
      };
      dailyPickRuntimeCaches.set(matchMode, failedCache);
      console.error('Erro ao publicar analise diaria na API PlacarPro:', err.message);
      throw err;
    })
    .finally(() => {
      dailyPickRefreshPromises.delete(matchMode);
    });

  dailyPickRefreshPromises.set(matchMode, refreshPromise);
  return refreshPromise;
};

const hasAiAnalysis = (cache) => {
  const selectedEvents = filterEventsForMode(cache?.data?.selectedEvents || [], cache?.data?.matchMode);
  if (!cache?.data?.analysisResult || selectedEvents.length === 0) return false;
  return selectVariedEntries(cache.data.analysisResult, selectedEvents, PREMIUM_ENTRY_LIMIT).length > 0;
};

const hasDailyPickEvents = (cache) => filterEventsForMode(cache?.data?.selectedEvents || [], cache?.data?.matchMode).length > 0;

const ensureDailyPick = async ({ requireAnalysis = false, mode = 'prelive' } = {}) => {
  const matchMode = normalizeMatchMode(mode);
  const cacheKey = getDailyPickCacheKey(matchMode);

  if (
    dailyPickRuntimeCaches.get(matchMode)?.cacheKey === cacheKey
    && dailyPickRuntimeCaches.get(matchMode)?.data
    && hasDailyPickEvents(dailyPickRuntimeCaches.get(matchMode))
    && (!requireAnalysis || hasAiAnalysis(dailyPickRuntimeCaches.get(matchMode)))
  ) {
    return dailyPickRuntimeCaches.get(matchMode);
  }

  const published = await readPublishedDailyPick(matchMode);
  if (published?.data && hasDailyPickEvents(published) && (!requireAnalysis || hasAiAnalysis(published))) {
    dailyPickRuntimeCaches.set(matchMode, published);
    return published;
  }

  const state = await readDailyPickPublicationState(matchMode);

  if (DAILY_PICK_READ_ONLY) {
    return {
      cacheKey,
      data: null,
      updatedAt: state?.updated_at ? new Date(state.updated_at).getTime() : 0,
      error: state?.status === 'failed'
        ? state.error
        : 'Analise diaria ainda nao publicada.',
      status: state?.status || 'pending',
    };
  }

  if (!requireAnalysis) {
    if (!state || DAILY_PICK_ON_DEMAND_ENABLED || state.status === 'failed') {
      publishDailyPickIfNeeded(matchMode).catch(() => null);
    }

    return getFastDailyPick(matchMode, state).catch((err) => ({
      cacheKey,
      data: null,
      updatedAt: Date.now(),
      error: getPublicDailyPickError(err.message),
      status: state?.status || 'pending',
    }));
  }

  if (!state || DAILY_PICK_ON_DEMAND_ENABLED || state.status === 'failed') {
    const generated = await publishDailyPickIfNeeded(matchMode).catch((err) => ({
      cacheKey,
      data: null,
      updatedAt: Date.now(),
      error: err.message,
      status: 'failed',
    }));

    if (generated?.data && hasDailyPickEvents(generated) && (!requireAnalysis || hasAiAnalysis(generated))) {
      return generated;
    }

    const updatedState = await readDailyPickPublicationState(matchMode);
    return {
      cacheKey,
      data: null,
      updatedAt: updatedState?.updated_at ? new Date(updatedState.updated_at).getTime() : Date.now(),
      error: updatedState?.status === 'failed' ? updatedState.error : generated?.error || null,
      status: updatedState?.status || generated?.status || 'pending',
    };
  }

  return {
    cacheKey,
    data: null,
    updatedAt: state?.updated_at ? new Date(state.updated_at).getTime() : 0,
    error: state?.status === 'failed' ? state.error : null,
    status: state?.status || 'pending',
  };
};

const buildDailyPickPayload = (plan, cache = null, mode = 'prelive') => {
  const matchMode = normalizeMatchMode(mode || cache?.data?.matchMode);
  const activeCache = cache || dailyPickRuntimeCaches.get(matchMode);
  const selectedEvents = filterEventsForMode(activeCache?.data?.selectedEvents || [], matchMode);
  const analysisResult = selectedEvents.length ? activeCache?.data?.analysisResult : null;
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
    apostaDoDia = plan === 'premium' ? null : buildBasicEntryFromEvent(selectedEvents[0]);
    entradasPremium = [];
  }

  return {
    aposta_do_dia: apostaDoDia,
    entradas_premium: entradasPremium,
    aposta_do_dia_atualizando: Boolean(dailyPickRefreshPromises.get(matchMode)) || activeCache?.status === 'generating' || activeCache?.status === 'pending',
    aposta_do_dia_erro: getPublicDailyPickError(activeCache?.error),
    aposta_do_dia_atualizada_em: activeCache?.updatedAt || null,
    match_mode: matchMode,
  };
};

const runDailyPickSchedulerTick = async () => {
  await Promise.all(
    DAILY_PICK_SCHEDULER_MODES.map((mode) => publishDailyPickIfNeeded(mode).catch((err) => {
      console.error(`Scheduler de analise diaria falhou para ${mode}:`, err.message);
      return null;
    }))
  );
};

const startDailyPickScheduler = () => {
  if (!DAILY_PICK_SCHEDULER_ENABLED || DAILY_PICK_SCHEDULER_MODES.length === 0) return;

  const runTick = () => {
    runDailyPickSchedulerTick().catch((err) => {
      console.error('Scheduler de analise diaria falhou:', err.message);
    });
  };

  const firstRun = setTimeout(runTick, Math.max(0, DAILY_PICK_SCHEDULER_START_DELAY_MS));
  const interval = setInterval(runTick, Math.max(60 * 1000, DAILY_PICK_SCHEDULER_INTERVAL_MS));
  firstRun.unref?.();
  interval.unref?.();
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

const requireInternalDailyPickSecret = (req, res, next) => {
  const configuredSecret = String(process.env.DAILY_PICK_PUBLISH_SECRET || '').trim();
  const receivedSecret = String(req.headers['x-daily-pick-secret'] || req.body?.secret || '').trim();

  if (DAILY_PICK_READ_ONLY || process.env.DAILY_PICK_PUBLISHER_ENABLED === 'false') {
    return res.status(403).json({ error: 'Publicador de analises desativado nesta API.' });
  }

  if (!configuredSecret) {
    return res.status(503).json({ error: 'Publicacao interna de analises nao configurada.' });
  }

  if (!receivedSecret || receivedSecret !== configuredSecret) {
    return res.status(401).json({ error: 'Nao autorizado.' });
  }

  return next();
};

app.post('/api/internal/daily-pick/publish', requireInternalDailyPickSecret, async (req, res) => {
  const requestedModes = Array.isArray(req.body?.modes)
    ? req.body.modes
    : String(req.body?.mode || process.env.DAILY_PICK_PUBLISH_MODES || 'prelive').split(',');
  const modes = requestedModes
    .map((mode) => normalizeMatchMode(mode))
    .filter((mode, index, list) => list.indexOf(mode) === index);
  const force = req.body?.force === true || req.query.force === 'true';

  try {
    const results = [];
    for (const mode of modes) {
      const published = await generateAndPublishDailyPick({ mode, force });
      results.push({
        mode,
        status: published.status,
        reused: Boolean(published.reused),
        updatedAt: published.updatedAt,
        selectedEvents: filterEventsForMode(published.data?.selectedEvents || [], mode).length,
        hasAnalysis: Boolean(published.data?.analysisResult),
      });
    }

    res.json({
      success: true,
      date: getLocalDateKey(),
      provider: getDailyPickProvider(),
      cacheVersion: DAILY_PICK_CACHE_VERSION,
      results,
    });
  } catch (err) {
    console.error('Erro ao publicar analise diaria manualmente:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao publicar analise diaria.' });
  }
});

const getCheckoutPlan = async (requestedPlanId) => {
  const requested = Number(requestedPlanId);
  const hasRequestedPlan = Number.isInteger(requested) && requested > 0;
  const plan = hasRequestedPlan
    ? await get('SELECT * FROM plans WHERE id = ? AND active = TRUE', [requested])
    : await get("SELECT * FROM plans WHERE active = TRUE ORDER BY CASE WHEN slug = 'premium-mensal' THEN 0 ELSE 1 END, display_order, id LIMIT 1");
  if (hasRequestedPlan && !plan) {
    const error = new Error('Plano indisponivel.'); error.statusCode = 404; throw error;
  }
  return plan || { id: null, name: 'Premium Mensal', slug: 'premium', price_cents: PREMIUM_PLAN_PRICE };
};

const getPaymentSettings = async () => await get('SELECT * FROM payment_settings WHERE id = 1') || {
  trial_days: 0, max_accesses: 1, default_discount_percent: 0, mercado_pago_enabled: true, subscription_status: 'active',
};

const calculateCheckout = async ({ planId, couponCode }) => {
  const [plan, settings] = await Promise.all([getCheckoutPlan(planId), getPaymentSettings()]);
  if (!settings.mercado_pago_enabled) { const error = new Error('Pagamentos temporariamente desativados.'); error.statusCode = 503; throw error; }
  if (settings.subscription_status !== 'active') { const error = new Error('Novas assinaturas estao temporariamente pausadas.'); error.statusCode = 503; throw error; }

  const originalAmount = Number(plan.price_cents);
  let discountCents = Math.round(originalAmount * (Number(settings.default_discount_percent || 0) / 100));
  let coupon = null;
  const normalizedCode = String(couponCode || '').trim().toUpperCase();
  if (normalizedCode) {
    coupon = await get(`SELECT * FROM coupons WHERE UPPER(code) = ? AND active = TRUE
      AND (valid_from IS NULL OR valid_from <= CURRENT_TIMESTAMP)
      AND (valid_until IS NULL OR valid_until >= CURRENT_TIMESTAMP)
      AND (max_uses IS NULL OR uses_count < max_uses)`, [normalizedCode]);
    if (!coupon) { const error = new Error('Cupom invalido, expirado ou esgotado.'); error.statusCode = 422; throw error; }
    discountCents = coupon.discount_type === 'fixed'
      ? Number(coupon.discount_value)
      : Math.round(originalAmount * (Number(coupon.discount_value) / 100));
  }
  discountCents = Math.min(Math.max(0, discountCents), Math.max(0, originalAmount - 100));
  return { plan, settings, coupon, originalAmount, discountCents, finalAmount: originalAmount - discountCents };
};

app.get('/api/payments/config', authenticateToken, async (req, res) => {
  const testMode = isMercadoPagoTestMode();
  const [plan, plans, settings] = await Promise.all([
    getCheckoutPlan(req.query.planId),
    all('SELECT id, name, slug, price_cents, description, benefits, color, badge, billing_period FROM plans WHERE active = TRUE ORDER BY display_order, id'),
    getPaymentSettings(),
  ]);
  const defaultDiscount = Number(settings.default_discount_percent || 0);
  const publicPlans = plans.map((item) => ({
    ...item,
    checkout_price_cents: Math.max(100, Number(item.price_cents) - Math.round(Number(item.price_cents) * defaultDiscount / 100)),
  }));
  const selectedPublicPlan = publicPlans.find((item) => Number(item.id) === Number(plan.id));

  res.json({
    publicKey: process.env.MERCADOPAGO_PUBLIC_KEY || '',
    amount: Number((Number(selectedPublicPlan?.checkout_price_cents || plan.price_cents) / 100).toFixed(2)),
    plan: { id: plan.id, name: plan.name, slug: plan.slug },
    plans: publicPlans,
    paymentSettings: {
      trialDays: settings.trial_days,
      maxAccesses: settings.max_accesses,
      defaultDiscountPercent: Number(settings.default_discount_percent || 0),
      mercadoPagoEnabled: settings.mercado_pago_enabled,
      subscriptionStatus: settings.subscription_status,
    },
    testMode,
    testBuyerEmail: testMode ? (String(process.env.MERCADOPAGO_TEST_BUYER_EMAIL || '').trim() || null) : null,
    allowTestApproval: process.env.ALLOW_PAYMENT_TEST_APPROVAL === 'true',
  });
});

app.post('/api/payments/coupon/validate', authenticateToken, async (req, res) => {
  try {
    const pricing = await calculateCheckout({ planId: req.body?.planId, couponCode: req.body?.couponCode });
    res.json({
      valid: true,
      coupon: pricing.coupon ? { code: pricing.coupon.code, discountType: pricing.coupon.discount_type, discountValue: pricing.coupon.discount_value } : null,
      originalAmount: Number((pricing.originalAmount / 100).toFixed(2)),
      discount: Number((pricing.discountCents / 100).toFixed(2)),
      amount: Number((pricing.finalAmount / 100).toFixed(2)),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post('/api/payments/trial', authenticateToken, async (req, res) => {
  try {
    const [settings, previous] = await Promise.all([
      getPaymentSettings(),
      get('SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1', [req.user.id]),
    ]);
    if (settings.subscription_status !== 'active' || Number(settings.trial_days) <= 0) return res.status(403).json({ error: 'Periodo de teste indisponivel.' });
    if (previous) return res.status(409).json({ error: 'O periodo de teste ja foi utilizado.' });
    const plan = await getCheckoutPlan(req.body?.planId);
    await run(`INSERT INTO subscriptions (user_id, plan_id, status, trial_ends_at, ends_at, access_limit)
      VALUES (?, ?, 'active', CURRENT_TIMESTAMP + (? * interval '1 day'), CURRENT_TIMESTAMP + (? * interval '1 day'), ?)`,
      [req.user.id, plan.id, settings.trial_days, settings.trial_days, settings.max_accesses]);
    await run("UPDATE users SET plano = 'premium', role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'premium' END, plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [plan.id, req.user.id]);
    res.json({ premium: true, trialDays: settings.trial_days });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
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

    const sessionId = crypto.randomUUID();
    await run("INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, CURRENT_TIMESTAMP + interval '24 hours')", [sessionId, result.id]);
    const token = jwt.sign({ id: result.id, email, role: 'free', sid: sessionId }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: result.id, nome, email, plano: 'basico', role: 'free', status: 'active', saldo: 0, banca_inicial: 0 } });
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

    if (user.status === 'blocked') {
      return res.status(403).json({ error: 'Usuario bloqueado. Entre em contato com o suporte.' });
    }

    await run('UPDATE user_sessions SET revoked = TRUE WHERE user_id = ? AND expires_at <= CURRENT_TIMESTAMP', [user.id]);
    const accessSettings = await get('SELECT max_accesses FROM payment_settings WHERE id = 1');
    const activeSessions = await get('SELECT COUNT(*)::int total FROM user_sessions WHERE user_id = ? AND revoked = FALSE AND expires_at > CURRENT_TIMESTAMP', [user.id]);
    if (Number(activeSessions?.total || 0) >= Number(accessSettings?.max_accesses || 1)) {
      return res.status(403).json({ error: `Limite de ${accessSettings?.max_accesses || 1} acesso(s) simultaneo(s) atingido.` });
    }

    await run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    const userRole = user.role || (user.plano === 'premium' ? 'premium' : 'free');
    const sessionId = crypto.randomUUID();
    await run("INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, CURRENT_TIMESTAMP + interval '24 hours')", [sessionId, user.id]);
    const token = jwt.sign({ id: user.id, email: user.email, role: userRole, sid: sessionId }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
      token,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        plano: user.plano,
        role: userRole,
        status: user.status || 'active',
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
    const matchMode = normalizeMatchMode(req.query.matchMode);
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
    const dailyPick = await ensureDailyPick({ requireAnalysis: user.plano === 'premium', mode: matchMode }).catch((err) => ({
      cacheKey: getDailyPickCacheKey(matchMode),
      data: dailyPickRuntimeCaches.get(matchMode)?.data || null,
      updatedAt: dailyPickRuntimeCaches.get(matchMode)?.updatedAt || 0,
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
      ...buildDailyPickPayload(user.plano, dailyPick, matchMode),
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
    const matchMode = normalizeMatchMode(req.query.matchMode);
    const user = await get('SELECT plano FROM users WHERE id = ?', [req.user.id]);
    const dailyPick = await ensureDailyPick({ requireAnalysis: user?.plano === 'premium', mode: matchMode }).catch((err) => ({
      cacheKey: getDailyPickCacheKey(matchMode),
      data: dailyPickRuntimeCaches.get(matchMode)?.data || null,
      updatedAt: dailyPickRuntimeCaches.get(matchMode)?.updatedAt || 0,
      error: err.message,
    }));

    res.json(buildDailyPickPayload(user?.plano || 'basico', dailyPick, matchMode));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar aposta do dia' });
  }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  if (req.user.sid) await run('UPDATE user_sessions SET revoked = TRUE WHERE id = ? AND user_id = ?', [req.user.sid, req.user.id]);
  res.json({ success: true });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.sendStatus(404);
    if (user.status === 'blocked') return res.status(403).json({ error: 'Usuario bloqueado.' });

    res.json({
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        plano: user.plano,
        role: user.role || (user.plano === 'premium' ? 'premium' : 'free'),
        status: user.status || 'active',
        saldo: Number(user.saldo_atual || 0),
        banca_inicial: Number(user.banca_inicial || 0),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar usuario.' });
  }
});

const analysisQueryParams = (query = {}) => {
  const params = new URLSearchParams({
    includeOdds: 'false',
    useOddsFallback: 'false',
  });
  const allowed = [
    'date',
    'limit',
    'maxCandidates',
    'mode',
    'daysAhead',
    'analysisConcurrency',
    'analysisTimeoutMs',
    'analysisRetries',
    'analysisCacheTtlMs',
    'fullDailyCacheTtlMs',
    'profileTimeoutMs',
    'profileBudgetMs',
    'home',
    'away',
    'name',
    'match',
    'strictMarkets',
    'strictFull',
    'useLLM',
    'useLLMExplanation',
    'explainRejected',
    'includeEnrichment',
    'wait',
  ];

  allowed.forEach((key) => {
    if (query[key] !== undefined && String(query[key]).trim()) {
      params.set(key, String(query[key]).trim());
    }
  });

  return params;
};

const proxyAnalysis = async (req, res, upstreamPath, extraQuery = {}) => {
  try {
    const params = analysisQueryParams({ ...req.query, ...extraQuery });
    const response = await axios.get(`${PLACARPRO_API_URL}${upstreamPath}?${params}`, {
      timeout: Number(process.env.ANALYSIS_PROXY_TIMEOUT_MS || 360000),
    });

    res.status(response.status).json(response.data);
  } catch (err) {
    const status = Number(err.response?.status || 502);
    const upstreamError = err.response?.data?.error || err.response?.data?.message;
    console.error(`Erro ao consultar analise ${upstreamPath}:`, upstreamError || err.message);
    res.status(status >= 400 && status < 600 ? status : 502).json({
      ok: false,
      error: upstreamError || 'Nao foi possivel concluir a analise agora.',
    });
  }
};

// Uma partida ou exatamente tres IDs separados por virgula.
app.get('/api/analysis/events/:eventIds', authenticateToken, requirePremium, async (req, res) => {
  const eventIds = String(req.params.eventIds || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (![1, 3].includes(eventIds.length) || eventIds.some((id) => !/^\d+$/.test(id))) {
    return res.status(400).json({ error: 'Informe 1 ID ou exatamente 3 IDs numericos do OGOL.' });
  }

  return proxyAnalysis(req, res, `/analysis/${eventIds.join(',')}`);
});

app.get('/api/analysis/by-teams', authenticateToken, requirePremium, async (req, res) => {
  const home = String(req.query.home || '').trim();
  const away = String(req.query.away || '').trim();

  if (!home || !away) {
    return res.status(400).json({ error: 'Informe os dois times da partida.' });
  }

  return proxyAnalysis(req, res, '/analysis/by-teams');
});

app.get('/api/analysis/daily', authenticateToken, requirePremium, async (req, res) => {
  return proxyAnalysis(req, res, '/analysis/full-daily');
});

app.get('/api/analysis/jobs/:jobId', authenticateToken, requirePremium, async (req, res) => {
  const jobId = String(req.params.jobId || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: 'Job de analise invalido.' });
  }
  return proxyAnalysis(req, res, `/analysis/jobs/${jobId}`);
});

app.get('/api/analysis/tournament', authenticateToken, requirePremium, async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Informe o nome do campeonato.' });
  return proxyAnalysis(req, res, '/analysis/tournament');
});

app.get('/api/analysis/tournament/:tournamentId', authenticateToken, requirePremium, async (req, res) => {
  const tournamentId = String(req.params.tournamentId || '').trim();

  if (!/^\d+$/.test(tournamentId)) {
    return res.status(400).json({ error: 'Informe um ID de campeonato valido.' });
  }

  return proxyAnalysis(req, res, `/analysis/tournament/${tournamentId}`);
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

    const pricing = await calculateCheckout({ planId: req.body?.planId, couponCode: req.body?.couponCode });
    const { plan, coupon, originalAmount, discountCents, finalAmount } = pricing;
    const planPriceBrl = Number((finalAmount / 100).toFixed(2));
    const externalId = `${plan.slug || 'premium'}-${req.user.id}-${Date.now()}`;
    const notificationUrl = getPaymentNotificationUrl();
    const user = await get('SELECT email, nome FROM users WHERE id = ?', [req.user.id]);
    const paymentPayload = {
      transaction_amount: planPriceBrl,
      description: plan.name || process.env.MERCADOPAGO_PREMIUM_PRODUCT_DESCRIPTION || 'Acesso premium ao PlacarPro',
      payment_method_id: 'pix',
      external_reference: externalId,
      payer: {
        email: user?.email || req.user.email,
        first_name: user?.nome || undefined,
      },
      metadata: {
        userId: String(req.user.id),
        plan: plan.slug || 'premium',
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
      'INSERT INTO payment_sessions (user_id, checkout_id, external_id, status, plan, plan_id, coupon_id, original_amount, discount_cents, amount, checkout_url, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, payment.id, externalId, payment.status || 'pending', plan.slug || 'premium', plan.id, coupon?.id || null, originalAmount, discountCents, finalAmount, transactionData.ticket_url, JSON.stringify(payment)]
    );

    res.json({
      paymentMethod: 'pix',
      paymentId: payment.id,
      checkoutId: payment.id,
      externalId,
      status: payment.status,
      pricing: { originalAmount: originalAmount / 100, discount: discountCents / 100, amount: finalAmount / 100 },
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
    res.status(err.statusCode || 500).json({
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

    const pricing = await calculateCheckout({ planId: req.body?.planId, couponCode: req.body?.couponCode });
    const { plan, coupon, originalAmount, discountCents, finalAmount } = pricing;
    const planPriceBrl = Number((finalAmount / 100).toFixed(2));
    const externalId = `${plan.slug || 'premium'}-card-${req.user.id}-${Date.now()}`;
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
      transaction_amount: planPriceBrl,
      description: plan.name || process.env.MERCADOPAGO_PREMIUM_PRODUCT_DESCRIPTION || 'Acesso premium ao PlacarPro',
      token,
      installments,
      payment_method_id: paymentMethodId,
      external_reference: externalId,
      payer,
      metadata: {
        userId: String(req.user.id),
        plan: plan.slug || 'premium',
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
      'INSERT INTO payment_sessions (user_id, checkout_id, external_id, status, plan, plan_id, coupon_id, original_amount, discount_cents, amount, checkout_url, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, payment.id, externalId, payment.status || 'pending', plan.slug || 'premium', plan.id, coupon?.id || null, originalAmount, discountCents, finalAmount, null, JSON.stringify(payment)]
    );

    await activatePremiumFromPayment(payment);

    res.json({
      paymentMethod: 'card',
      paymentId: payment.id,
      externalId,
      status: payment.status,
      statusDetail: payment.status_detail,
      premium: isPaidStatus(payment.status),
      pricing: { originalAmount: originalAmount / 100, discount: discountCents / 100, amount: finalAmount / 100 },
    });
  } catch (err) {
    const details = getMercadoPagoErrorMessage(err);
    const mpDetails = getMercadoPagoErrorDetails(err);
    console.error('Erro no pagamento por cartao Mercado Pago:', {
      response: err.response?.data || err.message,
      requestId: err.response?.headers?.['x-request-id'] || err.response?.headers?.['x-correlation-id'],
      status: err.response?.status,
    });
    res.status(err.statusCode || 500).json({
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
databaseReady.then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    startDailyPickScheduler();
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Porta ${PORT} ja esta em uso. Feche a API antiga ou rode: npm run start:local`);
      process.exit(1);
    }
    console.error('Erro ao iniciar servidor:', err.message);
    process.exitCode = 1;
  });
}).catch((err) => {
  console.error('API nao iniciada porque o PostgreSQL falhou:', err.message);
  process.exitCode = 1;
});
