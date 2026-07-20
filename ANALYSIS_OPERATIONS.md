# Operacao e melhoria continua das analises

## Principio

O sistema nao promete assertividade antes de possuir amostra real. Cada entrada publicada e registrada em `analysis_predictions`, liquidada depois do jogo e usada na calibracao somente quando a amostra minima e atingida.

## Rotina diaria

1. Publique as analises pelo worker externo.
2. Consulte a operacao com `npm run analysis:operations`.
3. Liquide partidas encerradas com `npm run analysis:settle`.
4. Confirme que nao existem alertas criticos e que snapshots de odds foram registrados.

Para publicar hoje:

```powershell
npm run daily-pick:publish -- --force
```

Para publicar uma data especifica:

```powershell
npm run daily-pick:publish -- --date=2026-07-20 --force
```

Tambem e aceito `--date 2026-07-20`. Por seguranca, datas passadas sao bloqueadas e o limite futuro padrao e 14 dias, configuravel por `DAILY_PICK_MANUAL_MAX_DAYS_AHEAD`.

Sem `--date`, permanece o comportamento automatico existente: o worker tenta hoje e pode avancar ate dois dias para encontrar a proxima agenda elegivel. Com `--date`, somente a data informada e consultada e publicada.

## Backtest

Execute `npm run analysis:backtest -- --days=365`.

O relatorio apresenta:

- assertividade;
- lucro e ROI/yield por unidade;
- drawdown maximo;
- Brier Score e log loss;
- Closing Line Value (CLV);
- erro esperado de calibracao;
- cortes por mercado, campeonato, tier, confianca, qualidade dos dados e mes.

Resultados com poucas partidas devem ser tratados como `collecting`. Nao promova alteracoes com base em um periodo curto ou em um unico campeonato.

## Pesos

Execute `npm run analysis:weights -- --days=365`.

O sistema exige `ANALYSIS_WEIGHT_MIN_SAMPLE`, limita sugestoes entre 0.90 e 1.10 e nunca as aplica automaticamente. Toda mudanca deve passar por revisao, backtest fora da amostra e implantacao versionada em `ANALYSIS_WEIGHT_OVERRIDES_JSON` no worker.

## Monitoramento

`npm run analysis:operations` verifica:

- heartbeat do worker;
- idade e estado da ultima publicacao;
- fila de liquidacao atrasada;
- snapshots recentes de odds;
- disponibilidade e falhas por provedor de odds.

Alertas sao persistidos em `analysis_operational_alerts`. Quando a condicao desaparece, o alerta e resolvido automaticamente. O monitor nao chama SofaScore, OGOL, 365Scores ou casas de aposta.

Configure `ANALYSIS_ALERT_WEBHOOK_URL` para enviar alertas novos ou reativados ao Slack, Teams ou a uma automacao propria. Falha no webhook nao interrompe a API.

## Teste de carga

Com a API local em execucao:

```powershell
npm run load:test
```

Variaveis: `LOAD_TEST_BASE_URL`, `LOAD_TEST_PATH`, `LOAD_TEST_REQUESTS`, `LOAD_TEST_CONCURRENCY`, `LOAD_TEST_TIMEOUT_MS` e `LOAD_TEST_MAX_ERROR_RATE`.

O endpoint padrao e `/api/health`, evitando gerar analises ou consumir IA durante o teste.

## Sinais para interromper uma publicacao

- calibracao piorando de forma consistente;
- ROI negativo com amostra suficiente;
- drawdown acima do limite operacional;
- CLV persistentemente negativo;
- provedor de odds abaixo de 30% de disponibilidade;
- worker ou publicacao diaria atrasados;
- crescimento da fila de liquidacao.
