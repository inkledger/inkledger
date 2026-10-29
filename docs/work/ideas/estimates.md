# Spec: how long an issue will take, and when it will be done (#7)

Status: revision 3 approved (2026-10-29), with patch 3.1 (points 1–11) and its five corrections applied. Batch 1 done (pure L1, `contracts/estimate.ts`); Q8 answered (2026-10-29). Batches 2a1 and 2 done; 2a2 done but for Basecamp cards (Q10) and OpenProject (Q11). Open questions are asked when their batch is reached (README, R-0.12).

## Direction (approved 2026-10-29)
- **L1, per issue:** deterministic, in TypeScript. It uses similar closed issues of mine and their work time, weighted by how recent they are.
- **L2, in time:** Mistral **Timestral** (time-series models, open weights under a Modified MIT licence) runs in a Python sidecar and gives capacity, finish date and trend. `Timestral-28M` is the default, and it can be changed.

## Verified data
- **My time:** `worklogs` (`db/schema.ts:320`) holds only the user's own entries (`api/sync/worklogs.ts:361`). The issue a worklog belongs to is found with `issueOfWorklog` (`api/queries/worklogScope.ts:16`).
- **Features:** `issues.issueType` (may be empty), `components`, `containerId`, `timeEstimateSeconds`, `summary`, `category`. `priorityRank` and `labels` exist too: possible future features, not read by v1 (patch 3.1 point 6).
- **No closing date:**
  - There is no resolved date and no story points.
  - `statusChangedAt` can't stand in for one: only 13 of 1543 closed Jira issues have it on the dev data.
- **Status history:**
  - It is not stored today: `activity` held a single row, an assignee change.
  - The adapters can read it through `history` (`api/providers/types.ts:771`). Each entry is a `RemoteChange {at, actor, field, from: ChangeValue[], to: ChangeValue[]}`, and `ChangeValue.id` is optional.
  - Adapters with `history`: asana, azure, basecamp, gitea, gitlab, jira, linear, monday, openproject, plane, redmine, shortcut, todoist, trello, youtrack. GitHub has none.
- **Status identity:**
  - `RemoteIssue.status` is a `RemoteStatus {id, name, category}` (`types.ts:212-237`), and `statuses()` lists them for each source.
  - `issues` keeps only the status name (`status`). The id is not stored today.
- **Search:** `pg_trgm` exists in production and in PGlite; pgvector exists in neither.

## Definitions
- **Eligible sample:** a closed issue of mine whose work time can be trusted (R-3.1, R-3.4).
- **Work stretch:** a half-open interval `[from, until)`, in epoch ms, during which the issue's status counted as work. A worklog belongs to the stretch when `from ≤ started < until`.
- **Weighted quantile** of values `v₁…vₙ` with weights `w₁…wₙ > 0`, for `q ∈ (0, 1]`:
  - sort the pairs by value, ascending (equal values may be in any order: the result is the same);
  - let `W = Σ wᵢ` and `Cₖ = w₁ + … + wₖ`;
  - then `Q(q) = vₖ` for the smallest `k` with `Cₖ ≥ q·W − 10⁻⁹·W`.
- **Recency weight** of a sample: `w = 0.5^(age / 180)`, where `age = max(0, now − lastCountedWorklogAt) / 86 400 000` days.
- **Winsorization** of values `v` with weights `w`:
  - `lo = Q(0.05)` and `hi = Q(0.95)`, both computed with those same weights;
  - each `vᵢ` becomes `min(hi, max(lo, vᵢ))`;
  - the weights stay as they were.

## Requirements

### L1: the estimate
- **R-3.1** A sample is a closed issue of mine with all of these:
  - `category='done'` (never `cancelled`) and `goneAt IS NULL`;
  - a history state of `available` or `unsupported` (R-3.4);
  - a work time of at least 300 s.
  - There is no time window.
- **R-3.2** The universe of one estimate (patch 3.1 point 7):
  - **candidates:** my closed issues (R-3.1's first line) with at least one worklog of mine, my worklogs aggregated per issue, ordered by my latest worklog on each, newest first, at most **2000**;
  - on those 2000 only, each candidate is classified by history state: `available` and `unsupported` with work time ≥ 300 s become samples, the others are left out;
  - tiers, quantiles and calibration use only those samples;
  - `excluded` counts the candidates left out by state, among those 2000;
  - the estimate's `allWorklogs` counts the `unsupported` samples **in the chosen tier** (the ones behind the number shown). A count over all my closed issues is a separate query (`historyStates`), for Settings.
- **R-3.3** With fewer than **5** eligible samples in all, the answer is `{ none: true, n }` and **no number** is shown. With 5 or more, the tiers (R-3.6) decide.
- **R-3.4** History states of an issue, and how each one affects the estimate:

| State | Meaning | In the estimate |
|---|---|---|
| `available` | read, valid, not changed since | yes: the worklogs inside the work stretches |
| `unsupported` | the tracker has no `history` | yes: **all** my worklogs on the issue, and the answer says so (`allWorklogs`, R-3.2) |
| `pending` | never read | no |
| `stale` | read, but the issue changed afterwards (R-3.12) | no, until it is read again |
| `retry` | the last read failed; waiting for `nextAttemptAt` | no |
| `invalid` | read, but incoherent (R-3.11) | no |

  - The answer always counts the candidates left out because of their state: `excluded: {pending, stale, retry, invalid}` (R-3.2).
- **R-3.5** The weights are the recency weights.
  - P20, P50 and P80 are computed on the **winsorized** work times of the chosen tier.
  - They are then rounded: to 5 min below 2 h, to 15 min from 2 h on, and never below 5 min.
- **R-3.6** Tiers, from the most alike to the least. The first tier with at least 5 samples is used. T5 (all) is always reached once R-3.3 passes.
  - **T0:** same container, and title similarity ≥ 0.35. Only when both titles are **usable**: not null, and at least 3 characters once trimmed (the length of a trigram). Otherwise the similarity is `null` and T0 doesn't apply; the query's `coalesce` only avoids errors, never makes two empty titles alike (patch 3.1 point 8).
  - **T1:** same container and same type, with at least one component in common.
  - **T2:** same container and same type.
  - **T3:** same type.
  - **T4:** same container.
  - **T5:** all.
  - "Same type" needs both types to be non-null and equal. "Same container" needs the target's container to be non-null.
- **R-3.7** Confidence:
  - `low` when n < 8 or the tier is T4 or T5;
  - `high` when n ≥ 15 and the tier is T0, T1 or T2;
  - `medium` otherwise.
- **R-3.8** Calibration, **within the chosen tier**:
  - It uses the tier's samples that have a tracker estimate > 0. With fewer than 5 of them, calibration is `null`.
  - The ratios `rᵢ = workSeconds / trackerEstimate` are winsorized on their own, with their recency weights.
  - `ratio` is `Q(0.5)` of those, rounded to 2 decimals.
  - `calibrated = roundEstimate(target.trackerEstimate × ratio)` when the target has an estimate > 0, `null` otherwise.
- **R-3.9** No estimate is shown for issues that are `done` or `cancelled`.
- **R-3.10** TODOs:
  - A TODO linked to an issue shows the issue's estimate.
  - A TODO with no issue shows the ratio of my own TODO estimates, computed as in R-3.8. It needs at least 5 TODOs with `estimateSeconds` and `todoSessions` time > 0. The UI says "you usually take ×r".

### L1: work time from the status history
- **R-3.11** Work stretches and coherence:
  - **Order:** each change carries an `ordinal`: its index in the **complete** changelog, as the tracker returned it (`sourceOrdinal`, copied before status changes are picked out, so picking never renumbers). `toStatusChanges` keeps the tracker's order and never reorders changes; `workStretches` sorts the converted changes by `(at, ordinal)`, never by `at` alone.
  - **Conversion** of a tracker change (`RemoteChange`) to a `StatusChange` (`toStatusChanges`):
    - only status changes are converted. How each provider names its status field is **Q8**, which blocks batch 2;
    - `from` must hold zero or one value (zero means `null`), and `to` exactly one. Anything else makes the history **invalid** (`ambiguousChange`);
    - a value is taken by its `ChangeValue.id`. Without an id, its name must match exactly one current status of the connection; no match, or several, is `ambiguousChange`.
  - **Initial status:**
    - with no changes, the status at creation is the current status;
    - with changes, it is the first change's `from`. When that is `null`, the status at creation is unknown, and the history is **invalid** (`noInitialStatus`, decided 2026-10-29: what is not proven stays out, D-3.6);
    - a `null` `from` on any later change breaks the chain (`chain`).
  - **Current status** (checked after the chain): with no changes, `statusNow` is both the first and the current status; with changes, the last `to` must be `statusNow`, otherwise the history is **invalid** (`currentStatusMismatch`).
  - A stretch opens when the status becomes one that counts, and closes at the next status change. Stretches of zero length are dropped.
  - The history is **invalid** when any of these holds:
    - a change's `from` is not the previous change's `to`;
    - a change is earlier than the issue's creation, or later than the moment of the read;
    - a status has no id and its name doesn't match exactly one status of the connection;
    - a status id can be resolved neither by `statuses()` nor by a snapshot stored earlier (`unknownStatus`, patch 3.1 point 4);
    - the issue is closed but a stretch is still open at the end;
    - there are more than 5000 changes.
- **R-3.12** Staleness and re-reading:
  - **When a read goes stale:** when the sync stores the issue with a `remoteUpdatedAt` later than the one the read saw, or with a different `status_id`. A reopening by a tester is one of these cases.
  - **What gets read:** the history job reads `pending` and `stale` issues, and `retry` issues whose time has come. It takes at most 50 per pass, oldest first.
  - **Re-reading atomically:**
    - The tracker is read outside any transaction.
    - The result is written in **one** transaction: lock the read row, delete the issue's rows in `issue_status_changes`, insert the new ones with their new ordinals, then set the state, `sourceUpdatedAt`, `statusIdAtRead` and `generation + 1`.
    - It is written only if the row's `generation` is still the one seen before the read, and the issue's `remoteUpdatedAt` has not moved meanwhile. Otherwise nothing is written and the row stays `stale`.
  - **Failures:** a failed read sets `retry`, with `attempts + 1` and `nextAttemptAt = now + min(24 h, 5 min × 2^attempts)`. It never leaves rows half written.
  - **Read only:** every call to the tracker is a read (`intent: "read"`), so it works under `PROVIDERS_READ_ONLY=1`.
- **R-3.13** A status is identified by its **remote status id**, never by the name shown.
  - **Snapshots** (patch 3.1 point 4): each read saves, for every status it meets, `statusId`, `name` and `canonicalCategory` from `statuses()` in `status_snapshots`, per connection. A status later deleted on the tracker stays readable through its snapshot. Without a choice of the user (`work_statuses`, still keyed by id), its default comes from the category in the snapshot.
  - The history stores ids, and the choices per connection (R-3.14) are keyed by id, so a status renamed on the tracker keeps its choice.
  - `issues` gains a `status_id` column, filled by the sync from `RemoteIssue.status.id`.
  - While an issue row has no `status_id` yet, its history read stays `pending`.
- **R-3.14** Statuses that count as work: there is a default for each provider, and a choice for each connection.
  - **Default:** the statuses in the `doing` category. On a tracker that has no `doing` status (only open and closed), every status that is not `done` and not `cancelled`.
  - **Choice:** Settings → Estimates lists each connection's statuses (from `statuses()`), each with a switch. A change is saved in `work_statuses` and raises the revision (R-3.15).
- **R-3.15** Cache:
  - It is kept per user by each server process, for at most 10 min, and **only while the user's revision is unchanged**.
  - The revision is persistent (`estimate_revisions.revision`, one row per user). It is raised in the same transaction as every write that changes an estimate:
    - a worklog of the user is created, changed or deleted;
    - an issue of the user is stored with a different `category`, `status_id`, `issueType`, `components`, `containerId` or `timeEstimateSeconds`;
    - a history is written;
    - a `work_statuses` row changes;
    - a TODO's `estimateSeconds` changes, or a TODO with an estimate is created or deleted;
    - a `todoSessions` row is created, changed or deleted (patch 3.1 point 5; one revision for issue and TODO estimates).
  - Every estimate first reads the revision (one indexed query) and drops a cached entry whose revision differs. A write made by another instance is therefore seen at the next read.
  - **Raising is atomic** (patch 3.1 point 11): one statement, `INSERT … ON CONFLICT (user_id) DO UPDATE SET revision = estimate_revisions.revision + 1`, never read-then-write in JavaScript. The revision is a SQL `bigint` read as a JavaScript `BigInt` (`mode: "bigint"`), compared as such and keyed as its decimal string; it never goes through `number`.
- **R-3.16** Accuracy (backtest). Each sample whose last counted worklog falls in the last 90 days is taken in order:
  - it is predicted using only the samples whose `lastCountedWorklogAt` is earlier than its own. Cases with the same `lastCountedWorklogAt` are processed as one group: all predicted from the pool of earlier times, and only then added to it, so none trains on another whatever the input order;
  - when fewer than 5 such samples exist, the case is **not** a prediction: it counts in `skipped` and never in the metrics.
  - The answer:
    - `n` is the number of predictions made;
    - `mdape` is the median of `|P50 − real| / real × 100`;
    - `coverage` is the % of real values within `[P20, P80]`;
    - with `n = 0`, `mdape` and `coverage` are `null`.

### L2: Timestral
- **R-3.17** Capacity (`forecast.capacity`):
  - **Series:** my logged hours per day over the last 365 days, with missing days as 0, by `dayKey` in the local zone, capped at 24 per day.
  - **Covariates** `workday` (from `workSchedule`) and `off` (from `plannedEntries` of the vacation kind), both for the past and the future (patch 3.1 point 10):
    - `past_covariates.workday` and `.off` for the same 365 days as the series, day by day;
    - `future_covariates.workday` and `.off` for the horizon;
    - every array has the length of its span and the same `dayKey`s; the builder (`capacityInput`, pure) refuses otherwise, and the sidecar answers 422 to any length mismatch.
  - **Horizon:** 7 to 90 days. Quantiles 0.1, 0.5 and 0.9.
- **R-3.18** The model's answer is cleaned before use, in this order:
  1. every value must be finite, otherwise E-3.3;
  2. negative values become 0;
  3. each day's quantiles are sorted, so that `p10 ≤ p50 ≤ p90` (this fixes quantile crossing);
  4. a day with `off = 1` is **0 in every quantile**, whatever the model said. Passing `off` as a covariate doesn't guarantee that on its own.
- **R-3.19** Finish (`forecast.finish`):
  - **Work to do:** the sum of the open issues' P50 (`workP50`) and P80 (`workP80`). Issues with no estimate are named in `unknown` and left out.
  - **`p50`:** the first day on which the cumulative P50 capacity reaches `workP50`.
  - **`p80`:** the first day on which the cumulative **P10** capacity reaches `workP80`.
    - It is a **conservative planning bound**: pessimistic work over pessimistic capacity. It is **not** a true 80th percentile of the end date.
    - The UI says "at the latest", and the doc explains why.
  - **Beyond the horizon**, for each bound on its own (patch 3.1 point 9): a date beyond the horizon (90 days) is `null`, with `p50Beyond` / `p80Beyond` true and `remainingHoursP50` / `remainingHoursP80` the hours left at the horizon. So the answer can say "around 15 December; conservative bound beyond 27 January", both beyond, or both within.
- **R-3.20** Trend (`forecast.trend`), in its own Reports section:
  - **Weeks:** ISO weeks (starting Monday, local zone). Each closed sample goes into the week of its `lastCountedWorklogAt`.
  - **Two series:**
    - A: the median work time, in hours, of the week's samples;
    - B: the median of `work / trackerEstimate`, over the samples that have an estimate.
  - **Missing weeks:**
    - weeks with no samples at the start and at the end are dropped;
    - weeks with no samples in between are filled with a straight line between their neighbours, and marked `imputed` in the answer.
  - **Minimum:** each series needs at least 12 weeks from its first to its last, and at least 8 of them with data. Otherwise that series answers `{ insufficient: true, have, need: 8 }`.
  - **Horizon:** 12 weeks. Quantiles 0.1, 0.5 and 0.9, cleaned as in R-3.18 (without `off`).
  - **Direction:** `better`, `worse` or `flat`, from the change of P50 between the last observed week and week 12 (±5%). For both A and B, lower is better.
- **R-3.21** The sidecar (`ml/forecast/`):
  - **Pinned models:** `ml/forecast/models.lock.json` lists, for each model, `{ repo, revision (an immutable commit sha), files: [{ path, sha256 }] }`.
  - **Download:**
    - files go to a temporary folder in the `ml-models` volume;
    - each one is checked against its sha256;
    - the folder is then renamed **atomically** to `models/<repo>@<revision>`;
    - on a mismatch, the temporary folder is deleted and the service stays not ready.
  - **Lock:** an exclusive lock (`flock` on `models/.lock`) covers the download, so two starts never download at once. The second waits, then finds the files already there.
  - **Never in the image:** the weights are never put into the image.
  - **Endpoints:**
    - `GET /health` means the process is up (200);
    - `GET /ready` means the model is verified and loaded (200), or 503 with the reason;
    - `/forecast` answers 503 until the model is ready.
  - **Node side:** `forecast.available` reads `/ready`. When `FORECAST_URL` is unset, the forecast sections don't appear.

## Out of scope
- Team estimates (Q3: only mine).
- Story points.
- Title embeddings: a possible v3 with pgvector, which needs a different image.

## Decisions
- **D-3.1** L1 is pure TypeScript, with tiers plus trigrams.
  - *Why:* it is explainable ("12 similar issues"), testable, and needs no infrastructure.
- **D-3.2** L2 runs in a Python sidecar.
  - *Why:* Timestral's inference code is Python.
- **D-3.3** `Timestral-28M` is the default (`FORECAST_MODEL`).
- **D-3.4** Work time comes from the status stretches, not from a closing date.
  - *Why:* that is the user's rule: what counts is the time logged while the issue was being worked on, so reopenings count and waits don't.
- **D-3.5** The history is read once, stored, and read again when it goes stale.
  - *Why:* reading it at every estimate would be slow and would need the tracker online.
- **D-3.6** Anything not proven valid stays out of the estimate. Only `unsupported` (no history exists at all) uses all worklogs, and it says so.
  - *Why:* a wrong number is worse than "not enough history".
- **D-3.7** Recency weights apply everywhere: quantiles, winsorization, calibration.
  - *Why:* one single notion of how much a sample counts.

## Data model
```ts
// issues: + statusId: text("status_id")  — RemoteIssue.status.id, filled by the sync (R-3.13)

/** An issue's status history read (R-3.4, R-3.12). */
export const issueHistoryReads = pgTable(
  "issue_history_reads",
  {
    itemId: integer("item_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** available | pending | unsupported | stale | retry | invalid */
    state: text("state").notNull(),
    /** Raised by every write of this row: a read writes only over the generation it saw */
    generation: integer("generation").notNull().default(0),
    readAt: ms("read_at"),
    /** The issue's remoteUpdatedAt and status_id when it was read: later ones make it stale */
    sourceUpdatedAt: epochMs("source_updated_at"),
    statusIdAtRead: text("status_id_at_read"),
    changes: integer("changes").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ms("next_attempt_at"),
    /** Why it is invalid or failed (a code, never tracker content) */
    reason: text("reason"),
  },
  (t) => [
    index("idx_issue_history_reads_due").on(t.userId, t.state, t.nextAttemptAt),
    check("issue_history_reads_state", sql`${t.state} IN ('available','pending','unsupported','stale','retry','invalid')`),
  ],
);
/** A status the user set apart from the provider's default (R-3.14), by remote status id. */
export const workStatuses = pgTable(
  "work_statuses",
  {
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    connectionId: integer("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    statusId: text("status_id").notNull(),
    counts: integer("counts").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.connectionId, t.statusId] })],
);
/** An issue's status changes as its tracker returned them (R-3.11): ids, in (at, ordinal) order. Replaced whole by each read. */
export const issueStatusChanges = pgTable(
  "issue_status_changes",
  {
    itemId: integer("item_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    /** The change's index in the order the tracker returned the history: ties on `at` keep it */
    ordinal: integer("ordinal").notNull(),
    at: ms("at").notNull(),
    /** Remote status ids; null `from` only on the first change (which then makes the history invalid) */
    fromStatusId: text("from_status_id"),
    toStatusId: text("to_status_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.ordinal] }), index("idx_issue_status_changes_order").on(t.itemId, t.at, t.ordinal)],
);
/** A status as last seen on its tracker (R-3.13): a status deleted since stays readable. */
export const statusSnapshots = pgTable(
  "status_snapshots",
  {
    connectionId: integer("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    statusId: text("status_id").notNull(),
    name: text("name").notNull(),
    /** contracts/providers.ts STATUS_CATEGORIES */
    category: text("category").notNull(),
    seenAt: ms("seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.statusId] })],
);
/** What any estimate of the user depends on; raised by every write that changes one (R-3.15). */
export const estimateRevisions = pgTable("estimate_revisions", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  revision: bigint("revision", { mode: "bigint" }).notNull().default(sql`0`),
});
```
- **History rows** have their own table (below), not `activity`. `activity` has no column for the tracker's order, and its rows serve other purposes (differences seen between syncs, other fields).
- Current names shown in Settings come from `statuses()`. A status name is also stored in `status_snapshots` as historical metadata, so a deleted status remains explainable; identity and preferences always use `statusId`, never the name.
- **Migration:** `NNNN_work_history.sql`.

## Contracts (`contracts/estimate.ts`, pure)
```ts
export const MIN_SAMPLES = 5;
export type Sample = { workSeconds: number; type: string | null; components: string[]; containerId: number | null;
  trackerEstimate: number | null; lastCountedWorklogAt: number; similarity: number | null; allWorklogs: boolean };
/** A title T0 may compare: not null, ≥ 3 characters once trimmed (R-3.6). */
export function usableSummary(summary: string | null | undefined): boolean;
export type Target = { type: string | null; components: string[]; containerId: number | null; trackerEstimate: number | null };
export type Tier = 0 | 1 | 2 | 3 | 4 | 5;
export type Calibration = { ratio: number; n: number; calibrated: number | null };
export type Estimate =
  | { none: true; n: number }
  | { none: false; p20: number; p50: number; p80: number; n: number; tier: Tier; confidence: "low" | "medium" | "high";
      calibration: Calibration | null; allWorklogs: number };
export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number; // throws on empty, q ∉ (0,1], w ≤ 0
export function winsorize(values: readonly number[], weights: readonly number[]): number[];
export function recencyWeight(lastCountedWorklogAt: number, now: number): number;
export function roundEstimate(seconds: number): number;
export function estimate(samples: readonly Sample[], target: Target, now: number): Estimate;
export type Backtest = { n: number; skipped: number; mdape: number | null; coverage: number | null };
export function backtest(cases: readonly (Sample & { target: Target })[], now: number): Backtest;

export type StatusChange = { at: number; ordinal: number; from: string | null; to: string };   // remote status ids
/** What the conversion reads of a tracker change: only status changes are given to it (Q8). */
export type RemoteStatusChange = { sourceOrdinal: number; at: number; from: readonly { id?: string; text: string }[]; to: readonly { id?: string; text: string }[] };
export function toStatusChanges(changes: readonly RemoteStatusChange[], statuses: readonly { id: string; name: string }[]):
  { ok: true; changes: StatusChange[] } | { ok: false; reason: "ambiguousChange" };
export type Stretch = { from: number; until: number | null };                        // [from, until)
export type HistoryCheck =
  | { ok: true; stretches: Stretch[] }
  | { ok: false; reason: "chain" | "beforeCreation" | "afterRead" | "unknownStatus" | "openOnClosed" | "tooMany" | "ambiguousChange" | "noInitialStatus" | "currentStatusMismatch" };
/** classify: whether a status counts as work, or null when neither statuses() nor a snapshot resolves it (unknownStatus). */
export function workStretches(input: { changes: readonly StatusChange[]; createdAt: number; readAt: number; statusNow: string;
  classify: (statusId: string) => boolean | null; closed: boolean }): HistoryCheck;
export function workSeconds(worklogs: readonly { started: number; seconds: number }[], stretches: readonly Stretch[]): number;
export function countsAsWork(status: { category: string; hasDoing: boolean; override?: boolean }): boolean;
```
- `contracts/forecast.ts` (pure):
  - `capacityInput(history, future)` builds the series and both covariate spans, aligned by `dayKey` (R-3.17);
  - `cleanQuantiles(days, off)` (R-3.18);
  - `finishDate(capacity, workP50, workP80, startDay)` (R-3.19);
  - `weeklySeries(samples, now)` (R-3.20).

## API
```ts
// api/routers/estimates.ts
forIssue: .input(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))
  // → (Estimate & { excluded: { pending: number; stale: number; retry: number; invalid: number } }) | { hidden: "closed" }
historyStates: .query()   // → { available, pending, unsupported, stale, retry, invalid: number } over all my closed issues with my time (Settings)
forTodo:  .input(z.object({ id: z.number().int().positive() }))   // → Estimate-like | { todoRatio: number; n: number } | { none: true; n: number }
accuracy: .query()                                                // → Backtest
workStatuses: .input(z.object({ connectionId: z.number().int().positive() }))
  // → { statusId: string; name: string; category: string; counts: boolean; byDefault: boolean }[]
setWorkStatus: .input(z.object({ connectionId: z.number().int().positive(), statusId: z.string().min(1).max(200), counts: z.boolean().nullable() }))
  // null: back to the default. Raises the revision.
// api/routers/forecast.ts (only with FORECAST_URL or FORECAST_SIMULATOR)
available: .query()   // → { available: boolean; model: string | null; reason: string | null }  (reads /ready)
capacity:  .input(z.object({ days: z.number().int().min(7).max(90) }))
  // → { days: { day: string; p10: number; p50: number; p90: number; off: boolean }[] }   hours, cleaned (R-3.18)
finish:    .input(z.union([z.object({ issues: z.array(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive() })).min(1).max(200) }),
                          z.object({ bucketId: z.number().int().positive() })]))
  // → { p50: string | null; p80: string | null; p50Beyond: boolean; p80Beyond: boolean; remainingHoursP50: number; remainingHoursP80: number;
  //     counted: number; unknown: number; workP50Hours: number; workP80Hours: number }
trend:     .query()
  // → { work: Series | { insufficient: true; have: number; need: 8 }; ratio: Series | { insufficient: true; have: number; need: 8 } }
  //   Series = { weeks: { week: string; value: number | null; imputed: boolean }[]; forecast: { week: string; p10: number; p50: number; p90: number }[]; direction: "better" | "worse" | "flat" }
```
**Sidecar:**
- `GET /health` → 200 `{up: true}`.
- `GET /ready` → 200 `{model, revision}`, or 503 `{reason}`.
- `POST /forecast` takes `{series, freq: "D" | "W", horizon, quantiles, future_covariates?, past_covariates?}` and returns `{quantiles}`. It answers 422 on invalid input and 503 until the model is ready.
- `FORECAST_FAKE=1` makes the sidecar answer deterministically, for tests.
- Node simulator: `FORECAST_SIMULATOR=1` (seasonal naive; p10/p90 at ±30%).

**Errors**

| E | Code | Key | When |
|---|---|---|---|
| E-3.1 | NOT_FOUND | `server.issues.notFound` (exists) | issue or connection not mine |
| E-3.2 | PRECONDITION_FAILED | `server.forecast.off` | forecast with no service |
| E-3.3 | BAD_GATEWAY | `server.forecast.bad` | sidecar answer not finite or not in shape |
| E-3.4 | TIMEOUT | `server.forecast.slow` | > 30 s |
| E-3.5 | NOT_FOUND | `server.buckets.notFound` | bucket not mine |
| E-3.6 | PRECONDITION_FAILED | `server.forecast.notReady` | sidecar up, model not ready |
| E-3.7 | NOT_FOUND | `server.estimates.unknownStatus` | `setWorkStatus` with a status id the connection doesn't have |

## UI
- **Issue page** (`IssueDetail.tsx:703-745`, `QuickStatsCard`):
  - a new `extra` item "Likely: 3 h 30 – 5 h";
  - a `note` "median {p50} · {n} similar issues · {basis}", and a confidence `Chip`;
  - when `allWorklogs > 0`: "{count} counted with all their worklogs (no history on their tracker)";
  - when issues are left out: "{count} waiting for their history";
  - the calibration line "Tracker {estimate} · you usually take ×{ratio} → {calibrated}";
  - when there is no estimate: "Not enough history yet ({n} of 5)". A closed issue shows nothing.
- **TODO** (`EstimateChip`): a faded "~{p50}" placeholder; a click sets it as the estimate.
- **Settings → Estimates:**
  - one group per connection, with its statuses by category, each with a switch;
  - the default is marked, with "Back to default";
  - how many of my closed issues are in each history state (`available`, waiting, not supported, invalid).
- **Reports:**
  - **"Estimate accuracy":** a coverage `Meter`, "typical error {mdape}%", `n`, and "{skipped} without enough earlier history".
  - **"Forecast":**
    - a chart of the next days: P10–P90 band and P50 line, with days off at 0;
    - the finish: "around {p50}, at the latest {p80}", or "after {date}".
  - **"Trend":** the two weekly series, with imputed weeks drawn hollow, the 12-week band, and "getting faster", "getting slower" or "steady".
  - The charts follow the `dataviz` skill.

**i18n** (en / it), in addition to the keys from revision 2:

| Key | en | it |
|---|---|---|
| `ui.estimate.none` | Not enough history yet ({n} of 5) | Storico ancora insufficiente ({n} su 5) |
| `ui.estimate.allWorklogs` | {count} counted with all their worklogs (no history on their tracker) | {count} contate con tutti i worklog (il tracker non ha lo storico) |
| `ui.estimate.waiting` | {count} waiting for their history | {count} in attesa del loro storico |
| `settings.estimates.title` | Estimates | Stime |
| `settings.estimates.counts` | Counts as work | Conta come lavoro |
| `settings.estimates.default` | default | predefinito |
| `settings.estimates.reset` | Back to default | Torna al predefinito |
| `pages.reports.accuracy.skipped` | {count} without enough earlier history | {count} senza abbastanza storico precedente |
| `pages.reports.forecast.beyond` | after {date} | dopo il {date} |
| `pages.reports.forecast.mixed` | around {p50}; conservative bound beyond {date} | verso il {p50}; limite prudente oltre il {date} |
| `pages.reports.forecast.bound` | "At the latest" is a cautious planning bound, not a probability. | "Al più tardi" è un limite prudente per pianificare, non una probabilità. |
| `pages.reports.trend.title` | Trend | Andamento |
| `pages.reports.trend.better/worse/flat` | getting faster / getting slower / steady | stai migliorando / stai rallentando / stabile |
| `pages.reports.trend.insufficient` | Needs {need} weeks with closed issues, {have} so far | Servono {need} settimane con issue chiuse, finora {have} |

## Performance
- `forIssue`:
  - uncached: p95 < 50 ms on the perf seed, in 2 queries (revision + samples);
  - cached: 1 query (the revision).
- History job: at most 50 tracker reads per pass, never in parallel (one at a time per connection).
- Sidecar: idle RSS < 600 MB with 28M; `/forecast` for 365 days in and 90 out takes < 500 ms on CPU.

## AC → test

| AC | Given / When / Then | Test |
|---|---|---|
| AC-3.1 | values 4,1,3,2 weights 4,1,2,1 · Q(0.2)=2, Q(0.5)=3, Q(0.8)=4; empty or q=0 throws | `contracts/estimate.test.ts` "weighted quantiles follow their definition" |
| AC-3.2 | winsorize with recency weights · lo/hi are the weighted Q(0.05)/Q(0.95), an old outlier weighs less | same, "winsorizing uses the same recency weights" |
| AC-3.3 | 4 eligible samples · `{none:true,n:4}`; 5 · a number | same, "four samples give no number, five do" |
| AC-3.4 | T0 with 4 and T1 with 10 · tier 1, n 10 | same, "the first tier with five samples is used" |
| AC-3.5 | 19 usual + one of 200 h · P80 ≤ the weighted P95 | same, "an outlier does not drag the range" |
| AC-3.6 | the chosen tier has 6 with ratio 1.5 and outside it 6 with ratio 3 · ratio 1.5; a ratio outlier is winsorized; < 5 in the tier · null | same, "calibration comes from the chosen tier, its ratios winsorized" |
| AC-3.7 | 1 h 07 → 1 h 05; 2 h 07 → 2 h 00; 60 s → 5 min | same, "estimates are rounded to readable steps" |
| AC-3.8 | n 16 T1 high; n 9 T2 medium; n 20 T4 low; n 6 T0 low | same, "confidence follows how many and how alike" |
| AC-3.9 | type null on target or sample · never "same type" | same, "an issue with no type matches no type" |
| AC-3.10 | 8 cases; the first 5 have < 5 earlier · skipped 5, n 3; none with enough · n 0, mdape null | same, "the backtest counts only the predictions it could make" |
| AC-3.11 | a future 10 h case exists · it is never used for earlier ones | same, "the backtest never peeks at the future" |
| AC-3.12 | stretch [10:00, 12:00) · worklog at 10:00 counts, at 12:00 does not, at 11:59:59.999 counts | same, "stretches include their start and exclude their end" |
| AC-3.13 | done 12:00, tester back to in progress 14:00, done 15:00; worklogs 11:00, 13:00, 14:30 · 1 h 30 | same, "a tester's reopening counts again, the wait between does not" |
| AC-3.14 | chain break; change before creation; after read; unknown id; closed issue ending open; 5001 changes · each its reason | same, "an incoherent history is refused with its reason" |
| AC-3.15 | Jira-like and open/closed-only · defaults; override wins | same, "work statuses default by provider" |
| AC-3.16 | 7 samples: 3 `available`, 1 `unsupported`, 1 `stale`, 1 `invalid`, 1 `pending` · only 4 eligible → none; `excluded` counts 1/1/0/1 | `api/routers/estimates.test.ts` "only proven histories make samples, and the left-out are counted" |
| AC-3.17 | `unsupported` issue in the chosen tier · all its worklogs count, `allWorklogs` 1 | same, "without history on the tracker every worklog counts, and it says so" |
| AC-3.18 | 2500 worklogs over 2100 issues · 2000 samples, one per issue, the most recent | same, "the sample limit applies to issues, not worklogs" |
| AC-3.19 | user B · forIssue/workStatuses/setWorkStatus of A · NOT_FOUND | same, "another user's issue has no estimate" |
| AC-3.20 | done issue · `{hidden:"closed"}` | same, "a closed issue shows no estimate" |
| AC-3.21 | two router instances on one database: A caches, B writes a worklog · A's next read recomputes (revision changed) | same, "a cache never outlives a write made by another instance" |
| AC-3.22 | cached · 1 query; uncached · 2 | same, "an estimate reads the revision, then the samples once" |
| AC-3.23 | TODOs: 6 with ratio 1.2 · todoRatio 1.2 | same, "a TODO without issue gets my TODO habit" |
| AC-3.24 | Jira simulator changelog read twice · native rows equal the changelog by status id, no duplicates, only read calls | `api/estimates/history.test.ts` "the status history is read once, replaced on a new read, never written" |
| AC-3.25 | history `available`; the sync stores the issue reopened (new status_id, later remoteUpdatedAt) · `stale`; the next pass rereads it and the new stretch counts | same, "a reopened issue's history goes stale and is read again" |
| AC-3.26 | the issue changes again while its history is being read · nothing written, still `stale` | same, "a read overtaken by a change writes nothing" |
| AC-3.27 | tracker unreachable · `retry`, attempts 1, next in 5 min; no rows | same, "a failed read leaves no half history and waits" |
| AC-3.28 | status 10001 renamed "In Progress" → "Doing" on the tracker · its choice and its stretches unchanged | same, "a renamed status keeps its identity" |
| AC-3.29 | "Waiting for customer" (doing) switched off · its stretches stop counting; revision raised | `estimates.test.ts` "a status switched off stops counting" |
| AC-3.30 | a model day p10 5 > p50 4 > p90 3 · sorted to 3/4/5; −1 → 0; NaN → E-3.3 | `contracts/forecast.test.ts` "forecast quantiles are made finite, non-negative and ordered" |
| AC-3.31 | a vacation day with model p50 6 h · 0 in every quantile | same, "a day off is zero whatever the model says" |
| AC-3.32 | work 2000 h with 5 h/day · `p50` and `p80` null, both `Beyond` true, remaining hours given | same, "a finish beyond the horizon says so" |
| AC-3.33 | 3 issues p50 10 h, capacity P50 5 h/day, P10 2 h/day · p50 day 2, p80 later from P10 | same, "the finish walks P50 capacity and bounds with P10" |
| AC-3.34 | 20 weeks, 6 with no samples between · filled and marked imputed; 7 weeks with data · insufficient | same, "weekly series fill gaps and need eight weeks" |
| AC-3.35 | simulator · capacity 28 days, `off` days 0 | `api/routers/forecast.test.ts` "capacity follows my week and my holidays" |
| AC-3.36 | FORECAST_URL unset · available false, E-3.2; `/ready` 503 · E-3.6 | same, "no forecast until its service is ready" |
| AC-3.37 | 3 issues, one with no estimate · `unknown` 1 | same, "issues without history are named, not guessed" |
| AC-3.38 | simulator · trend weekly points, band, direction | same, "the trend says where my times are going" |
| AC-3.39 | sidecar: a checksum mismatch · not ready, temp gone; two starts · one download; `/health` 200 while `/ready` 503 | `ml/forecast/tests/test_models.py` "test_download_is_checked_atomic_and_locked" |
| AC-3.40 | sidecar FORECAST_FAKE · `/forecast` shape, 422, 503 before ready | `ml/forecast/tests/test_api.py` "test_forecast_shape_validation_and_readiness" |
| AC-3.41 | issue page · range, basis, confidence, waiting count | `e2e/estimates.test.mjs` "the issue page says how long it likely takes" |
| AC-3.42 | TODO "~4 h" · click · set | same, "a TODO takes the suggested estimate in one click" |
| AC-3.43 | Settings → Estimates · switch a status off · the issue page's estimate changes | same, "the statuses that count as work are chosen per connection" |
| AC-3.44 | Reports · accuracy with skipped, forecast with "at the latest" note, trend (simulator) | same, "Reports shows accuracy, forecast and trend" |
| AC-3.45 | 320 px, light and dark · issue page, Settings → Estimates, Reports | same, "estimates at 320 px" |
| AC-3.46 | two changes at the same `at`, returned by the tracker in the order to In Progress then to Done, receive increasing ordinals; even if the stored or input `StatusChange` array is later shuffled, `workStretches` sorts by `(at, ordinal)` and reconstructs the same stretches | `contracts/estimate.test.ts` "changes at the same instant keep the tracker's order" |
| AC-3.47 | `from` empty → `null`; one value → its id; `to` empty or two values, `from` two values → `ambiguousChange`; no id and the name matching two statuses or none → `ambiguousChange`; no id and one match → that id | same, "tracker changes become status changes only when unambiguous" |
| AC-3.48 | the first change's `from` is `null` · invalid `noInitialStatus`; a later change's `from` `null` · invalid `chain` | same, "an unknown first status makes the history invalid" |
| AC-3.49 | a valid history through status 10005; 10005 then deleted on the tracker (gone from `statuses()`, kept in `status_snapshots` with category `doing`) · a new read and a new computation give the same stretches and work time; without the snapshot · `unknownStatus` | `api/estimates/history.test.ts` "a status deleted since is still read through its snapshot" |
| AC-3.50 | a TODO ratio cached · a new todo session, or a changed TODO estimate · the next call recomputes (revision +1 each) | `estimates.test.ts` "a TODO's estimate or session changes the TODO ratio" |
| AC-3.51 | 2100 candidates (the oldest 100 `pending`) · `excluded.pending` counts only those among the newest 2000; two `unsupported` samples, one in the chosen tier and one outside · `allWorklogs` 1; `historyStates` counts all | same, "counters count within their universe" |
| AC-3.52 | target or sample summary null, "", "  ", "ab" · similarity null, never T0; "abc" usable | `contracts/estimate.test.ts` "titles too short to compare never make tier 0" |
| AC-3.53 | work P50 reached on day 40, work P80 not by day 90 · `p50` set, `p80` null, `p50Beyond` false, `p80Beyond` true, `remainingHoursP80` > 0 | `contracts/forecast.test.ts` "the likely date can fall within the horizon and the bound beyond it" |
| AC-3.54 | `past_covariates.off` one day short, or `future_covariates.workday` one day long · `capacityInput` refuses; the sidecar answers 422 | same, "misaligned covariates are refused"; `ml/forecast/tests/test_api.py` "test_misaligned_covariates_are_refused" |
| AC-3.55 | two revision raises for one user at once (two connections, one with no row yet) · the revision ends at +2, as a `BigInt` | `api/queries/estimateRevision.test.ts` "two raises at once both count" |
| AC-3.56 | history ending in In Progress, issue `statusNow` Done · invalid `currentStatusMismatch`; matching final status · valid | `contracts/estimate.test.ts` "a history must end in the issue's current status" |
| AC-3.57 | two cases with the same `lastCountedWorklogAt` never train on one another, and reversing their input order leaves `n`, `skipped`, `mdape` and `coverage` unchanged | same, "cases worked at the same instant never train on one another" |

## Traceability (every R has its ACs)

| R | AC |
| --- | --- |
| R-3.1 | AC-3.16, AC-3.17 |
| R-3.2 | AC-3.18, AC-3.51 |
| R-3.3 | AC-3.3 |
| R-3.4 | AC-3.16, AC-3.17, AC-3.25, AC-3.27 |
| R-3.5 | AC-3.1, AC-3.2, AC-3.5, AC-3.7 |
| R-3.6 | AC-3.4, AC-3.9, AC-3.52 |
| R-3.7 | AC-3.8 |
| R-3.8 | AC-3.6 |
| R-3.9 | AC-3.20 |
| R-3.10 | AC-3.23, AC-3.42 |
| R-3.11 | AC-3.12, AC-3.13, AC-3.14, AC-3.46, AC-3.47, AC-3.48, AC-3.56 |
| R-3.12 | AC-3.24, AC-3.25, AC-3.26, AC-3.27 |
| R-3.13 | AC-3.28, AC-3.49 |
| R-3.14 | AC-3.15, AC-3.29, AC-3.43 |
| R-3.15 | AC-3.21, AC-3.22, AC-3.50, AC-3.55 |
| R-3.16 | AC-3.10, AC-3.11, AC-3.44, AC-3.57 |
| R-3.17 | AC-3.35, AC-3.54 |
| R-3.18 | AC-3.30, AC-3.31 |
| R-3.19 | AC-3.32, AC-3.33, AC-3.37, AC-3.53 |
| R-3.20 | AC-3.34, AC-3.38, AC-3.44 |
| R-3.21 | AC-3.36, AC-3.39, AC-3.40 |
| R-0.6 (README) | AC-3.41, AC-3.45 |
| R-0.8 (README) | AC-3.19 |

## Edge cases
- An issue with no type (GitHub): only T0, T4 and T5 apply (AC-3.9).
- `components` or `labels` JSON that isn't valid is treated as empty.
- A key moved to another project: the item link follows it, and the history belongs to the item.
- More than 24 h logged in one day (parallel work): the capacity series caps it at 24.
- A DST change: `dayKey` handles it; a test fixture covers it (R-3.17, R-3.20).
- A status deleted on the tracker remains resolvable through its stored snapshot. The history is invalid with `unknownStatus` only when the id can be resolved neither by the current statuses nor by a stored snapshot.

## Batches
1. [x] **Pure L1** (`contracts/estimate.ts`): quantiles, winsorization, recency, tiers, the minimum of 5, calibration, the conversion of tracker changes, stretches `[from, until)` in `(at, ordinal)` order with the coherence checks, default work statuses, backtest. AC-3.1–3.15, 3.46–3.48, 3.52, 3.56, 3.57.
2a. **Status history in the adapters (Q8).** Approved 2026-10-29, split in two: **2a1** contract, Jira and the single-field trackers (AC-3.58, 3.59, the single-field rows of 3.60); **2a2** the composite trackers (their rows of 3.60, AC-3.61, 3.62).
   - **Contract** (`api/providers/types.ts`, `api/providers/core/operations.ts` `TRACKER_OPTIONAL`, `validate.ts`): capability `statusHistory` and
     ```ts
     /** One change of the issue's status, in the tracker's order; ids are those of statuses() and of the issue's status. */
     export type RemoteStatusStep = { at: Instant; from: { id: string; name: string } | null; to: { id: string; name: string } };
     statusHistory?(x: CallContext<T, O>, ref: IssueRef): Promise<RemoteStatusStep[]>;
     ```
     A step whose `from` equals its `to` is never emitted. The batch-1 conversion takes `sourceOrdinal` from the index in this list.
   - **Jira:** the status id is the numeric id everywhere in the adapter (search, `getIssue`, `statusHistory`: changelog items with `field` "status" and `fieldtype` "jira", ids from `from`/`to`).
   - **Single-field trackers:** Azure (`System.State`, id = name as in its statuses()), Linear, Monday (the status column only), Plane, Redmine, Shortcut, Trello, YouTrack (State found by the field's `$type`, now requested).
   - **Composite trackers, replaying their derived status:** Asana (completed, else section by gid, requesting `old_section.gid`/`new_section.gid`), Basecamp (column, else completed; column moves read), GitLab (closed, else scoped label, else opened; a state event's `from` is the previous derived status; "reopened" leads back to the label or "opened"), Gitea (open/closed), Todoist (completed, else section, else open; section moves read if the API has them), OpenProject (status from structured activity data, not from the rendered text).
   - **ACs:**

     | AC | Given / When / Then | Test |
     |---|---|---|
     | AC-3.58 | an adapter declares `statusHistory` without the method, or the reverse · validate · a problem is reported | `api/providers/core/validate.test.ts` "status history is declared with its method" |
     | AC-3.59 | Jira simulator issue moved twice · `getIssue` and `statusHistory` · the same numeric ids, names localized | `api/providers/jira/adapter.test.ts` "Jira statuses are known by their numeric id" |
     | AC-3.60 | each of the 14 other adapters, simulator issue moved twice · `statusHistory` · every id is one of its `statuses()` (or of the issue's status), each `from` is the previous `to`, the last `to` is the issue's status | `api/providers/statusHistory.test.ts` "every tracker's status history uses the ids of its statuses" (table-driven, one row per tracker) |
     | AC-3.61 | GitLab: opened, label `workflow::doing` added, closed, reopened · steps opened→doing→closed→doing | same, "a composite status is replayed as the app computes it" (rows for Asana, Basecamp, GitLab, Todoist) |
     | AC-3.62 | a composite tracker whose status at creation can't be known · the first step's `from` is `null` | same, "an unknown starting status is left unknown" |
   - **2a1 done (2026-10-29).** Decisions the code forced, to review:
     - AC-3.60 runs from each adapter's own test (`statusHistoryConformance` in `api/providers/conformance/suite.ts`, the way the rest of the provider contract runs), not from one `api/providers/statusHistory.test.ts`: it reuses each adapter's simulator setup instead of copying 14 of them. The test name is the AC's.
     - A status value an adapter can't place (no id, no single name match) throws `ProviderError("incompatible")` (`api/providers/core/statusSteps.ts`): batch 2 reads that as a history that can't be proven.
     - Jira: a status change is `field` "status" with `fieldtype` "jira", checked on the user's Italian Jira Server (three real changelogs, read-only). The changelog is read without the comments (`fetchChangelog`, split out of `fetchIssueHistory`).
     - Azure: a `System.State` change from no value is the creating revision; it is left out, and the next change's `from` gives the status at creation.
     - Monday: an empty cell is the blank status (id `blank`, as `getIssue` gives it), which `statuses()` doesn't list. Batch 2 must place it (snapshot or a fixed default).
     - Plane: a value with no `old/new_identifier` is placed by its name when exactly one state of the project has it; the docs (developers.plane.so, issue activity) give the identifiers as the values' UUIDs.
     - YouTrack: activities now request `field(id,name,customField(fieldType(id)))`; State is the field whose `fieldType.id` starts with `state[` (developer portal, custom fields: `state[1]` is a single State field). A state's name is its id, as in its `statuses()`.
   - **2a2 done in part (2026-10-29).** Facts from the vendors' docs and source (research report, sources in the batch's commit message), and decisions, to review:
     - **GitLab:** `resource_state_events` holds `closed` and `reopened` and never the creation (docs: "does not track the initial state"); an issue starts `opened`. The replay starts with no labels and must end with the issue's labels of the workflow scope, else `incompatible` (labels at creation leave no event). Events of one instant (a scoped label swapped) make one step. A label deleted since → `incompatible`.
     - **Gitea:** close and reopen are timeline types `close`/`reopen` (source); its status is open/closed only, so the replay is complete. Project column moves carry no column ids (out of its status today).
     - **Asana:** stories request `old_section.gid`/`new_section.gid` (OpenAPI `SectionCompact`). A task starts open, in its first move's old section (`null` = none). A task in several projects → `incompatible` (a move doesn't say whose section). A story that disagrees with the replay → `incompatible`. The subtype names (`section_changed`, `marked_complete`, `marked_incomplete`) are only in a 2019 Asana forum post, already used by the adapter.
     - **Todoist:** `/api/v1/activities` `moved` events carry `section_id` and `last_section_id` (docs); the simulator now records them. A task starts open in its first move's `last_section_id`. No `added` event (the free plan keeps 7 days) → the start is unknown, the first step comes from `null` (AC-3.62); with no step at all → `incompatible`. A recurring task (its completions leave it open), a move between projects, a section deleted since → `incompatible`.
     - **Basecamp:** to-dos replay `completed`/`uncompleted` (bc3-api `events.md`). A card's column moves are not documented as events → a card's history is `incompatible` (**Q10**).
     - **OpenProject:** activities have only rendered, localized text (OpenProject's `activity_model.yml`) → no `statusHistory`; the job makes its histories `invalid` (`noStatusHistory`), never `unsupported`, so they stay out as decided for Q8 (**Q11**).
     - A history that exists but can't be read as statuses is `invalid`; `unsupported` (every worklog counts) is only for a tracker with no history at all.
   - **Facts to check against each real API before its code:** GitLab `resource_state_events` values, Plane `old/new_identifier`, Basecamp's column-move event, YouTrack activity `field.id` and `$type`, Todoist section moves in its activity, OpenProject structured status in activities. Each one is asked if the docs don't settle it.
2. **History and data:**
   - migration: `issues.status_id`, `issue_history_reads`, `issue_status_changes`, `status_snapshots`, `work_statuses`, `estimate_revisions`;
   - the sync fills `status_id` and marks reads `stale`;
   - the read-only history job, with atomic re-reading and retry;
   - revision raises.
   - AC-3.24–3.28, 3.49, 3.55.
   - **Done (2026-10-29).** Decisions the code forced, to review (none of them changes product behaviour):
     - **Triggers, not calls in the code:** the revision raises and the stale marking are Postgres triggers of migration `0018_work_history` (`issues`, `worklogs`, `todos`, `todo_sessions`, `work_statuses`), so they happen in the same transaction as every write whatever path made it (two issue syncs, timeWrites, routers). The repo already does this (`drizzle/0013_mail_pins.sql`). One SQL function, `inkledger_raise_estimate_revision`, is the only raise; `api/queries/estimateRevision.ts` calls it too.
     - **Two columns added to the raising list:** an issue's `summary` (it moves T0's similarity) and `gone_at` (R-3.1 drops gone issues). More raising only invalidates the cache more often.
     - **Which issues get a read:** the closed ones (`category = 'done'`, not gone) with at least one worklog of the user: the candidates of R-3.2, nothing more is read from the trackers. A tracker whose adapter has no `statusHistory` gets `unsupported` without a call (after Q8 "no history" means no status history).
     - **"Oldest first"** is read as the longest waiting: never read first, then by last read, then by issue id.
     - **When the job runs:** right after each background sync pass (`api/syncScheduler.ts`), at most 50 reads; a failure of the job never fails the sync.
     - **What the job checks:** the coherence of R-3.11 that doesn't depend on which statuses count (chain, times, current status, unknown statuses, too many changes). `openOnClosed` depends on the user's work statuses and is left to the estimate (batch 3), which runs `workStretches` with the real choice.
     - **An answer the adapter can't read as statuses** (`ProviderError` `incompatible`) makes the history `invalid` (reason `incompatible`); every other failure is `retry`.
     - **No creation date** (`remoteCreatedAt` null): the "before creation" check can't apply, and the read goes on.
     - **Statuses known:** from `statuses()` and, for a status it doesn't list (monday's blank, a status deleted before its first read), from the synced issues that are in it (`issues.status_id`, `category`). Snapshots are taken from both.
     - **Jira lists its statuses** (`GET /rest/api/2/status`, read only): `statuses: true` on the Jira adapter. Nothing in the app called `statuses()` before, so no screen changes.
     - AC-3.55 runs on PGlite, which has one connection: the two raises interleave rather than overlap. The atomicity itself is the single `INSERT … ON CONFLICT` statement.
3. [x] **Estimates API:** `forIssue` (eligibility, exclusions, sample limit, cache keyed on the revision), `forTodo`, `workStatuses`, `setWorkStatus`, `historyStates`. AC-3.16–3.23, 3.29, 3.50, 3.51.
   - **Done (2026-10-30).** Decisions the code forced, to review:
     - **One query:** `api/estimates/estimate.ts` reads the revision, then one SQL statement returns the target, the newest 2000 candidates (with their worklogs, their status changes when `available`, and title similarity), the statuses known for their connections (snapshots, else synced issues) and the user's choices. AC-3.22 counts the queries of the estimate itself, not of the tRPC middleware.
     - **Text of E-3.7** (the spec had none): en "This status isn't one of the connection's." / it "Questo stato non è tra quelli della connessione.".
     - **A key on two connections** without `connectionId`: CONFLICT `server.connections.ambiguousKey`, as `issues.get` does.
     - **A connection not mine** answers `server.issues.notFound`, as E-3.1 says (its text is "Issue not found").
     - **`workStatuses`** lists what `statuses()` gives and, for a tracker that lists none, the statuses its synced issues are in (the job's same rule).
     - **An `available` history that doesn't hold with today's choices** (a stretch left open on a closed issue, `openOnClosed`) counts as `invalid` in `excluded`: the job checks only what doesn't depend on the choices.
     - **The TODO habit** weighs each TODO by the end of its last session; a TODO linked to an issue answers that issue's estimate (closed included: `{hidden: "closed"}`).
     - **AC-3.21** uses two caches in one process on one database, the way two server processes would share it.
     - `accuracy` belongs to batch 5, as the batch list says.
4. **L1 UI:** issue page, TODO chip, Settings → Estimates. AC-3.41–3.43, and 3.45 in part.
5. **Accuracy:** `accuracy`, plus its Reports section. AC-3.44 (the accuracy part).
6. **Sidecar:** model lock file, checked, atomic and locked download, `/health` and `/ready`, `FORECAST_FAKE`. It comes after B5 batch 4 and **Q1**. AC-3.39, 3.40, 3.54 (sidecar part).
7. **L2 API and UI:** `contracts/forecast.ts`, the `forecast` router (capacity, finish, trend), the simulator, and the Reports forecast and trend sections. AC-3.30–3.38, 3.44, 3.45, 3.53, 3.54 (builder part).

## Open questions
- **Q1, blocks batch 6 only (not 1–5):** read and accept the Modified MIT licence of the Timestral weights. Is 28M the default?
  - **Partly answered 2026-10-29:** 28M stays the default, and it can be changed. Reading the licence is still needed before batch 6.
- **Q2:** P20–P80 or P10–P90. **Answer 2026-10-29: P20–P80.**
- **Q3:** team estimates. **Answer 2026-10-29: only mine.**
- **Q4:** which date makes an issue closed.
  - **Answer 2026-10-29:** none. Work time is the time inside the status stretches, weighted by distance from today; the trend goes to Timestral.
- **Q5:** how the history is obtained. **Answer 2026-10-29:** read once, stored, kept current.
- **Q6:** which statuses count.
  - **Answer 2026-10-29:** a default per provider, changeable per connection. A tester's reopening counts again.
- **Q7, 2026-10-29:** the 18 corrections of revision 3. **Approved 2026-10-29**, with patch 3.1 (points 1–11) applied.
- **Q8, blocks batch 2:** how each provider marks a status change in its `history` (`RemoteChange.field`): Jira's id is `status`; the other 14 are to be checked in their adapters, not guessed. **Answers 2026-10-29**, after reading the 15 adapters and three real changelogs on the user's Jira Server (read-only GET):
  - **Where the rule lives:** in each adapter. The provider contract (`api/providers/types.ts`, checked by `api/providers/core/validate.ts`) gets a way for a tracker to say which history changes are status changes, with values in the same id space as its statuses.
  - **Trackers whose history can't be matched today** (Asana: section names without gid; Basecamp: card column moves dropped; GitLab: state events with no `from` and "reopened" for "opened", labels by name; Gitea and Todoist: open/closed only; OpenProject: English text only): **fix their adapters first**, in batch 2a, before batch 2.
  - **YouTrack:** request the field's `$type` in the activities and give State a stable field id.
  - **Jira:** the server sends no `fieldId`; a status change is `field` "status" with `fieldtype` "jira" (not translated on an Italian server, while other system fields use display names such as "Fix Version"); `from`/`to` hold the numeric status id and `fromString`/`toString` the localized name. **Switch Jira to numeric status ids everywhere** (issues, history, sync), with a migration of the stored ids.
  - **Jira ids, found while scoping (2026-10-29):** no Jira status id is stored today (the sync keeps only the name, `api/sync/issues.ts:35`; bucket columns map names), so the switch is inside the adapter; `issues.status_id` is new in batch 2, so no stored id has to be migrated.
  - **Contract (2026-10-29):** a separate optional adapter method, `statusHistory`, returning only status changes (not a flag on `RemoteChange`).
  - **Composite statuses (2026-10-29):** the adapter replays its history in order and emits a change whenever the status it would compute (the same rule as its `statusOf`) changes, `from` being the previous derived status. The status at creation comes from what the tracker guarantees; when it can't be known, the first `from` is `null` and the history is invalid (`noInitialStatus`).
  - Still to verify against each real API when batch 2a reaches it: GitLab's `resource_state_events` values, Plane's `old/new_identifier`, Basecamp's action name for a column move, YouTrack's activity `field.id` format.
- **Q10, blocks Basecamp cards in 2a2:** a Basecamp card's move between columns is not in the documented events (bc3-api: only `completed`, `uncompleted`, `created`, `assignment_changed`; the move endpoint is write-only). Options: (a) read one real card's events on your Basecamp (read-only GET) to see what a move records; (b) keep cards `invalid`, to-dos replayed; (c) Basecamp cards `unsupported` (all worklogs). Today: (b).
- **Q11, blocks OpenProject in 2a2:** OpenProject's activities give status changes only as text in the user's language (`details[].raw`/`html`, no ids). Options: (a) read one real work package's activities on your OpenProject (read-only GET) to see whether the `html` marks field and values in a fixed way that doesn't depend on the language; (b) parse the English sentence and require the API user's language to be English; (c) keep OpenProject `invalid`. Today: (c).
- **Q9:** a status since deleted on the tracker. **Answer 2026-10-29 (patch 3.1 point 4):** read through its stored snapshot; `unknownStatus` only when nothing resolves it.
