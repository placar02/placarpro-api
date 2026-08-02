const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const TECHNICAL_LANGUAGE = /\b(amostra|feature(?: score)?|evidence|data quality|edge|probability|confidence threshold|threshold)\b/i;
const ISOLATED_PERCENTAGE = /(?:^|[.!?]\s*)[^.!?]*\b\d{1,3}%[^.!?]*(?:[.!?]|$)/i;

const joinNatural = (items) => {
  if (items.length < 2) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`;
};

const evidenceFromConfirmation = (confirmation, homeName, awayName) => {
  const text = normalize(confirmation).toLowerCase();
  if (/forma recente/.test(text)) return `o desempenho recente de ${homeName} e ${awayName}`;
  if (/casa e fora|mandante|visitante/.test(text)) return `o rendimento do mandante em casa e do visitante fora`;
  if (/posicao|posição|pontos no campeonato/.test(text)) return `a diferença de desempenho mostrada na competição`;
  if (/escanteio|corner/.test(text)) return `o volume de escanteios registrado pelas equipes`;
  if (/cart|disciplina/.test(text)) return `o comportamento disciplinar recente das equipes`;
  if (/gol|ofensiv|ataque/.test(text)) return `a produção ofensiva recente das equipes`;
  if (/defes/.test(text)) return `o desempenho defensivo observado nos jogos recentes`;
  if (/confronto|head.to.head|h2h/.test(text)) return `o histórico recente deste confronto`;
  if (/fontes|corroborados|consenso/.test(text)) return `a concordância dos dados obtidos em diferentes fontes`;
  return '';
};

const selectedCandidate = (entry) => {
  const audit = entry?.meta?.decisionAudit || {};
  return (audit.candidates || []).find((candidate) => (
    candidate.market === audit.selectedMarket
    && candidate.recommendation === audit.selectedRecommendation
  )) || (audit.candidates || []).find((candidate) => candidate.rejectionReasons?.length === 0);
};

const fitSummary = (text) => {
  const normalized = normalize(text);
  if (normalized.length <= 350) return normalized;
  const shortened = normalized.slice(0, 350);
  const sentenceEnd = Math.max(shortened.lastIndexOf('.'), shortened.lastIndexOf('!'), shortened.lastIndexOf('?'));
  return sentenceEnd >= 250 ? shortened.slice(0, sentenceEnd + 1) : `${shortened.slice(0, 347).trimEnd()}...`;
};

function buildDecisionBasedSummary(entry, context = {}) {
  const homeName = normalize(context.homeName || entry?.homeTeamName || entry?.homeTeam?.name) || 'o mandante';
  const awayName = normalize(context.awayName || entry?.awayTeamName || entry?.awayTeam?.name) || 'o visitante';
  const recommendation = normalize(entry?.recommendation || entry?.bestEntry?.recommendation) || 'esta entrada';
  const candidate = selectedCandidate(entry);
  const confirmations = Array.isArray(candidate?.confirmations) ? candidate.confirmations : [];
  const evidence = [...new Set(confirmations
    .map((item) => evidenceFromConfirmation(item, homeName, awayName))
    .filter(Boolean))].slice(0, 2);

  if (!evidence.length) return '';

  const first = `Recomendamos ${recommendation} porque a análise considerou ${joinNatural(evidence)}.`;
  const second = `Esses fatores foram usados em conjunto na avaliação do confronto e sustentam este mercado, sem depender de um único número isolado.`;
  const base = `${first} ${second}`;
  const complete = base.length >= 250
    ? base
    : `${base} A recomendação se apoia somente nos sinais confirmados para esta partida.`;
  return fitSummary(complete);
}

function buildUserAnalysisSummary(entry, context = {}) {
  const aiText = normalize(entry?.rationale || entry?.matchAnalysis);
  const aiIsSuitable = aiText.length >= 250
    && aiText.length <= 350
    && !TECHNICAL_LANGUAGE.test(aiText)
    && !ISOLATED_PERCENTAGE.test(aiText);
  return aiIsSuitable ? aiText : buildDecisionBasedSummary(entry, context) || fitSummary(aiText);
}

module.exports = { buildUserAnalysisSummary, buildDecisionBasedSummary };
