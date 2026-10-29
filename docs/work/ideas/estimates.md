# Spec: how long an issue will take, and when it will be done (#7)

Status: planned 2026-10-29, not started. Open questions are asked when their batch is reached (README, R-0.12).


## Clarification
- "Timestral" is Mistral's **Timestral**: time-series models released 2026-10-15, open weights under a Modified MIT licence, 5M–209M parameters, running on CPU, with quantiles and covariates.
- It forecasts **series** (hours per day), not single issues. So there are two layers:
  - **L1:** per-issue estimates from my history, in TypeScript.
  - **L2:** a capacity forecast with Timestral, giving "when will I finish".

## Verified data
- My time comes from `worklogs` (`db/schema.ts:320`). The table holds the user's own entries ("Only the user's own", `api/sync/worklogs.ts:361`). The issue link is `issueOfWorklog` (`api/queries/worklogScope.ts:16`).
- Features come from `issues`: `issueType`, `priorityRank`, `components`, `labels` (JSON), `containerId`, `timeEstimateSeconds`, `summary`, `category`, `statusChangedAt`.
- There is no resolved date (`statusChangedAt` stands in) and no story points.
- `pg_trgm` is available in production and in PGlite (`connection.ts:64-75`). pgvector is not available in either.

## Requirements
- **R-3.1** Samples are my issues with all of the following:
  - `category='done'`;
  - `goneAt IS NULL`;
  - `statusChangedAt` in the last 24 months;
  - my time ≥ 300 s.
- **R-3.2** At most 2000 samples, the most recent first, read with **one** SQL query that includes `similarity(summary, $target)`.
- **R-3.3** Tiers. The first one with n ≥ 5 is used:
  - **T0**: same container and similarity ≥ 0.35;
  - **T1**: same container, same type, at least one component in common;
  - **T2**: same container and same type;
  - **T3**: same type;
  - **T4**: same container;
  - **T5**: everything.
- **R-3.4** P20, P50 and P80 are weighted quantiles.
  - Weight: `w = 0.5^(age_days/180)`.
  - Values are winsorized at P5/P95 within the tier first.
  - Results are rounded to 5 min (< 2 h) or 15 min (≥ 2 h).
- **R-3.5** Calibration applies when ≥ 5 samples have `timeEstimateSeconds > 0`.
  - `ratio` = the weighted median of real / estimate.
  - If the target has its own estimate, the output includes `calibrated = estimate × ratio`.
- **R-3.6** `confidence`:
  - `high` when n ≥ 15 and the tier is T0–T2;
  - `low` when n < 8 or the tier is T4–T5;
  - `medium` otherwise.
  - If the total history is under 3 → `{none: true}` and **no number** is shown.
- **R-3.7** Not shown for issues that are `done` or `cancelled`.
- **R-3.8** `accuracy`: for each issue closed in the last 90 days, predict using only samples whose `statusChangedAt` is earlier than that closing.
  - Report `mdape` (median absolute percentage error, using P50) and `coverage` (% of issues whose real time falls within P20–P80), plus `n`.
- **R-3.9** Cache in process per user for 10 minutes. It is invalidated whenever worklogs or issues of the user are written (the sync and `timeWrites` hooks).
- **R-3.10** TODOs:
  - with an issue → the issue's estimate;
  - without an issue → calibration of my TODO estimates (TODOs with `estimateSeconds` and `todoSessions` time > 0, n ≥ 5) → "you usually take ×r".
- **R-3.11 (L2)** `forecast.capacity`:
  - series = my hours per day for the last 365 days, zero-filled, by `dayKey` in the local zone;
  - known-future covariates: `workday` (0/1 from `workSchedule`) and `off` (0/1 from `plannedEntries` with the vacation kind);
  - horizon ≤ 90 days; quantiles 0.1/0.5/0.9.
- **R-3.12 (L2)** `forecast.finish`: given open issues (≤ 200, or a bucket), sum their P50 (and P80) from L1, then walk the forecast cumulative capacity (P50 and P10) and return the dates `p50` and `p80`.
  - Issues with `none` are counted under `unknown` and **excluded**.
  - The UI shows "N issues without enough history".
- **R-3.13 (L2)** The sidecar:
  - downloads the weights at first start into the volume `ml-models`, and never puts them in the image;
  - `/health` returns 503 until the model is loaded.
  - Unset `FORECAST_URL` → the forecast section is absent.

## Out of scope
- Team estimates (see Q3).
- Story points.
- Title embeddings (a possible v3 with pgvector, which needs a different image).

## Decisions
- **D-3.1** L1 in pure TypeScript with tiers plus trigrams, no ML.
  - *Why:* explainable ("12 similar issues"), testable, no infrastructure.
- **D-3.2** L2 as a separate Python sidecar.
  - *Why:* Timestral's inference code is in Python. Node only takes the HTTP answer.
- **D-3.3** Model `Timestral-28M` by default.
  - *Why:* a good balance on CPU (5M ≈ 10 ms, 209M ≈ 140 ms). Configurable with `FORECAST_MODEL`.

## Pure code (`contracts/estimate.ts`)
```ts
export type Sample = { seconds: number; type: string; priorityRank: number | null; components: string[]; labels: string[];
  containerId: number | null; trackerEstimate: number | null; closedAt: number /* epoch ms */; similarity: number };
export type Target = { type: string; components: string[]; containerId: number | null; trackerEstimate: number | null };
export type Tier = 0 | 1 | 2 | 3 | 4 | 5;
export type Estimate =
  | { none: true; n: number }
  | { none: false; p20: number; p50: number; p80: number; n: number; tier: Tier; confidence: "low" | "medium" | "high";
      calibration: { ratio: number; n: number; calibrated: number | null } | null };
export function estimate(samples: readonly Sample[], target: Target, now: number): Estimate;
export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number;
export function winsorize(values: readonly number[], lo: number, hi: number): number[];
export function roundEstimate(seconds: number): number;
export function backtest(samples: readonly (Sample & { target: Target })[]): { mdape: number; coverage: number; n: number };
```

## API
```ts
// api/routers/estimates.ts
forIssue:  .input(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))  // → Estimate | { hidden: "closed" }
forTodo:   .input(z.object({ id: z.number().int().positive() }))   // → Estimate | { todoRatio: number, n: number } | { none: true }
accuracy:  .query()                                                // → { mdape, coverage, n }
// api/routers/forecast.ts (only if FORECAST_URL or FORECAST_SIMULATOR)
available: .query()                                                // → { available: boolean, model: string | null }
capacity:  .input(z.object({ days: z.number().int().min(7).max(90) }))
           // → { days: { day: string; p10: number; p50: number; p90: number }[] }  (hours)
finish:    .input(z.union([z.object({ issues: z.array(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive() })).min(1).max(200) }),
                          z.object({ bucketId: z.number().int().positive() })]))
           // → { p50: string | null; p80: string | null; counted: number; unknown: number; hoursP50: number; hoursP80: number }
```

**Sidecar** (`ml/forecast/`, FastAPI):
- `GET /health` → `{ok, model}` / 503.
- `POST /forecast`, input:
  ```
  {series: number[] (≤ 32768), freq: "D", horizon: int 1..90, quantiles: number[] (⊂ 0..1, ≤ 21),
   future_covariates?: {workday: number[], off: number[]} (length = horizon), past_covariates?: same keys (length = series)}
  ```
  → `{quantiles: {"0.1": number[], …}}`. A 422 if the input is invalid.
- Model pinned to a commit of `mistralai/timestral`. Tested with pytest (fake model, `FORECAST_FAKE=1`).
- Node client: `api/ml/forecast.ts`, with a 30 s timeout.
- `FORECAST_SIMULATOR=1`: seasonal naive (the mean of the same weekday over 4 weeks; p10/p90 = ±30%).

**Errors**

| E | Code | Key | When |
|---|---|---|---|
| E-3.1 | NOT_FOUND | `server.issues.notFound` (exists) | issue not mine |
| E-3.2 | PRECONDITION_FAILED | `server.forecast.off` | forecast with no service |
| E-3.3 | BAD_GATEWAY | `server.forecast.bad` | invalid sidecar answer |
| E-3.4 | TIMEOUT | `server.forecast.slow` | > 30 s |
| E-3.5 | NOT_FOUND | `server.buckets.notFound` | bucket not mine |

## UI
- **Issue page** (`IssueDetail.tsx:703-745`, `QuickStatsCard`): a new `extra` item `{label: t("ui.estimate.likely"), value: "3 h 30 – 5 h"}`.
  - `note`: `ui.estimate.basis` "median {p50} · {n} similar issues · {basis}". `basis` is one of `ui.estimate.tier.0…5`.
  - A `Chip` gives the confidence.
  - With calibration: "Tracker {estimate} · you usually take ×{ratio} → {calibrated}".
  - `none` → "Not enough history yet". Closed issue → nothing.
- **TODO** (`EstimateChip`, `TodoChips.tsx:208`): when there is no estimate and an estimate exists (from the issue, or the TODO ratio), show the faded placeholder "~{p50}". Clicking it sets `estimateSeconds = p50`.
- **Reports:**
  - an "Estimate accuracy" section: `Meter` coverage plus "typical error {mdape}%" plus n;
  - when forecast is available, a "Forecast" section: a chart of the next N days (P10–P90 band, P50 line; follow the `dataviz` skill and the existing charts in Reports), and "Finish the open issues of {bucket}: around {p50}, at the latest {p80}".

**i18n** (en / it):

| Key | en | it |
|---|---|---|
| `ui.estimate.likely` | Likely | Probabile |
| `ui.estimate.basis` | median {p50} · {n} similar issues · {basis} | mediana {p50} · {n} issue simili · {basis} |
| `ui.estimate.tier.0` | similar titles in this project | titoli simili in questo progetto |
| `ui.estimate.tier.1` | same project, type and component | stesso progetto, tipo e componente |
| `ui.estimate.tier.2` | same project and type | stesso progetto e tipo |
| `ui.estimate.tier.3` | same type | stesso tipo |
| `ui.estimate.tier.4` | same project | stesso progetto |
| `ui.estimate.tier.5` | all your issues | tutte le tue issue |
| `ui.estimate.confidence.low/medium/high` | rough / fair / solid | indicativa / discreta / solida |
| `ui.estimate.calibrated` | Tracker {estimate} · you usually take ×{ratio} → {calibrated} | Tracker {estimate} · di solito ci metti ×{ratio} → {calibrated} |
| `ui.estimate.none` | Not enough history yet | Storico ancora insufficiente |
| `pages.reports.accuracy.title` | Estimate accuracy | Precisione delle stime |
| `pages.reports.accuracy.body` | {coverage}% within the range · typical error {mdape}% · {n} issues | {coverage}% nell'intervallo · errore tipico {mdape}% · {n} issue |
| `pages.reports.forecast.title` | Forecast | Previsione |
| `pages.reports.forecast.finish` | Finish {count} open issues: around {p50}, at the latest {p80} | Chiudere {count} issue aperte: verso il {p50}, al più tardi il {p80} |
| `pages.reports.forecast.unknown` | {count} without enough history, not counted | {count} senza storico sufficiente, escluse |

## Performance
- `estimates.forIssue` p95 < 50 ms on the perf seed (500 issues, 1200 worklogs). Cached: < 2 ms.
- Issue page: at most one more tRPC call, included in the existing batch. The issue page's render budget MUST NOT rise.
- Sidecar: idle RSS < 600 MB with 28M. `/forecast` at 365→28 < 500 ms on CPU.

## AC → test

| AC | Given / When / Then | Test |
|---|---|---|
| AC-3.1 | known weighted values · quantiles equal hand-computed values | `contracts/estimate.test.ts` "weighted quantiles match the hand-computed ones" |
| AC-3.2 | 4 samples at T0 and 6 at T1 · tier 1 | same, "the first tier with five samples is used" |
| AC-3.3 | 2 samples total · none | same, "no number without three issues of history" |
| AC-3.4 | an outlier of 200 h · P80 does not exceed P95 of the tier | same, "an outlier does not drag the range" |
| AC-3.5 | 6 samples with estimate and ratio 1.5 · target with 4 h · calibrated 6 h | same, "a tracker estimate is calibrated on my habits" |
| AC-3.6 | 1 h 07 · 1 h 05; 2 h 07 · 2 h 00 | same, "estimates are rounded to readable steps" |
| AC-3.7 | backtest of a fixture · no sample after the closing is used | same, "the backtest never peeks at the future" |
| AC-3.8 | fixture of 30 closed issues · forIssue returns tier and n as expected; worklogs of a cancelled issue excluded | `api/routers/estimates.test.ts` "an issue's estimate comes from my closed issues" |
| AC-3.9 | user B · forIssue of A's issue · NOT_FOUND | same, "another user's issue has no estimate" |
| AC-3.10 | done issue · `{hidden:"closed"}` | same, "a closed issue shows no estimate" |
| AC-3.11 | a second call in the cache · 0 queries (`countQueries`); after a worklog write · it recomputes | same, "estimates are cached until my time changes" |
| AC-3.12 | TODO without issue, 6 TODOs with ratio 1.2 · `todoRatio` 1.2 | same, "a TODO without issue gets my TODO habit" |
| AC-3.13 | simulator · capacity 28 days · 28 days with p10 ≤ p50 ≤ p90; vacation days → ~0 | `api/routers/forecast.test.ts` "capacity follows my week and my holidays" |
| AC-3.14 | 3 issues p50 10 h and capacity 5 h/day · p50 about 2 working days | same, "a finish date walks the forecast capacity" |
| AC-3.15 | FORECAST_URL unset · available false, capacity E-3.2 | same, "no forecast without its service" |
| AC-3.16 | issue page · "Likely" with range and basis | `e2e/estimates.test.mjs` "the issue page says how long it likely takes" |
| AC-3.17 | TODO with issue without estimate · "~4 h" · click · the estimate is set | same, "a TODO takes the suggested estimate in one click" |
| AC-3.18 | Reports · accuracy and forecast (simulator) | same, "Reports shows accuracy and the forecast" |
| AC-3.19 | 320 px · issue and Reports without overflow | same, "estimates at 320 px" |
| AC-3.20 | sidecar FORECAST_FAKE · /forecast shape and 422 | `ml/forecast/tests/test_api.py` "test_forecast_shape_and_validation" |
| AC-3.21 | 30 closed issues · `forIssue` uncached · one query reads the samples (`countQueries`) | `estimates.test.ts` "samples are read in one query" |
| AC-3.22 | n 16 at T1 · high; n 9 at T2 · medium; n 20 at T4 · low; n 6 at T0 · low | `contracts/estimate.test.ts` "confidence follows how many and how alike" |
| AC-3.23 | 3 issues, one without history · `finish` · `unknown` 1, the date from the other two | `forecast.test.ts` "issues without history are named, not guessed" |
| AC-3.24 | sidecar started without weights · `/health` 503 until loaded; the image holds no weights (`docker image inspect` size and layers) | `ml/forecast/tests/test_api.py` "test_health_waits_for_the_model" + review |

## Traceability (every R has its ACs)

| R | AC |
| --- | --- |
| R-3.1 | AC-3.8 |
| R-3.2 | AC-3.8, AC-3.21 |
| R-3.3 | AC-3.2 |
| R-3.4 | AC-3.1, AC-3.4, AC-3.6, AC-3.16 |
| R-3.5 | AC-3.5 |
| R-3.6 | AC-3.3, AC-3.22 |
| R-3.7 | AC-3.10 |
| R-3.8 | AC-3.7, AC-3.18 |
| R-3.9 | AC-3.11 |
| R-3.10 | AC-3.12, AC-3.17 |
| R-3.11 | AC-3.13 |
| R-3.12 | AC-3.14, AC-3.23 |
| R-3.13 | AC-3.15, AC-3.20, AC-3.24 |
| R-0.6 (README) | AC-3.19 |
| R-0.8 (README) | AC-3.9 |

## Edge cases
- An issue without `issueType` (GitHub): only tiers T0, T4 and T5 apply.
- `components`/`labels` JSON that is not valid → treated as empty.
- An issue key moved to another project: the item link follows it.
- Days with more than 24 h logged in parallel (overlap policy): the capacity series uses logged hours, capped at 24 per day.
- A fresh zone change (DST): `dayKey` from `contracts/time.ts` handles it. Cover it with a fixture over the DST change.

## Batches
1. `contracts/estimate.ts` + `estimates.forIssue` + cache. AC-3.1–3.11.
2. Issue and TODO UI + `forTodo`. AC-3.12, 3.16, 3.17, 3.19 (partial).
3. `accuracy` + Reports section. AC-3.18 (accuracy part).
4. Sidecar + `forecast` router + simulator (after B5 batch 4 and Q1). AC-3.13–3.15, 3.20.
5. Forecast UI. AC-3.18 complete, 3.19.

## Open questions
- **Q1, blocks 4:** read and accept the Modified MIT licence of the weights. 28M as the default?
- **Q2, not blocking:** range P20–P80 (default) or P10–P90.
- **Q3, not blocking:** team estimates (default: no).

---
