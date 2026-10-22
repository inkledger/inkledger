# Measuring

How the numbers in [baseline.md](baseline.md) are taken, so any later run can be compared with it.
Each method reads what the code does today. None of them changes the application.

## Parity: nothing lost, nothing added

`api/parity/` freezes what the software offers. `pnpm parity:update` writes the inventories, and
`api/parity/parity.test.ts` regenerates them and fails on any difference. A change to an inventory
is a deliberate edit, explained in the commit that makes it.

| Inventory | File | What it holds |
|---|---|---|
| tRPC structure | `trpc-procedures.json` | Every procedure path and its type (query, mutation or subscription), sorted |
| tRPC contract | `trpc-contract.ts` | Every procedure's input and output, written out in full |
| tRPC compatibility | `trpc-compat.ts` | The current router held to the frozen contract, checked by `tsc -b` (`pnpm check`) |
| Routes | `routes.json` | Every route path of `src/App.tsx` (read with the TypeScript parser) and the layout route guarding it (`RequireAuth`, `GuestOnly` or none) |
| Settings sections | `settings-sections.json` | The categories in menu order, their native, desktop and permission limits, and the legacy ids that still land |
| i18n keys | `i18n-keys.json` | Every message key, en and it, with plurals marked |

The provider capability matrix is already frozen: `api/providers/catalogMatrix.test.ts` holds
`api/providers/CATALOG.md` to the code (`pnpm catalog:matrix`).

The **tRPC contract** contains standalone types only. It has no import and does not mention
`AppRouter`, `inferRouterInputs` or any alias from the code.
- **How types are written:**
  - A recursive type becomes a numbered alias (`Rec1`, ...), numbered in the order the
    contract first names it (then the aliases' own bodies, breadth first). The compiler's
    internal order never shows in the numbers.
  - Date, Map and Set stay as TypeScript's own types.
- **What fails generation instead of being weakened:** `any`, functions, classes, open generics,
  symbols and other library types.

**Two different guarantees, kept apart:**

- **Exact parity** (`parity.test.ts`, in `pnpm test`): every inventory regenerated equals the
  committed one, text for text. Any change shows, an addition as much as a removal: a new
  procedure, a new optional input field, a widened output, a renamed route or i18n key. This is
  what "nothing lost, nothing added" is held to.
- **Backward compatibility of the tRPC API** (`trpc-compat.ts`, in `pnpm check`): a weaker,
  type-level check. It passes a change when an old client's requests still type-check against
  the server and the server's answers still type-check against what the old client expects. It
  does not say the old client sees no difference: a new output field, a new error or a changed
  value can still reach it.
  - **Inputs:** each `FrozenIn[p]` must be assignable to the current input. The server still
    accepts everything an old client sends.
  - **Outputs:** each current output must be assignable to `FrozenOut[p]`. An old reader still
    reads what the server returns.
  - So a new optional input field or an extra output field passes compatibility while failing
    exact parity; a break in either direction stops `pnpm check`.
- **What neither covers:** behaviour behind the types (validation refinements, the values
  returned, side effects). The unit and e2e suites hold that.

## Bundle size

```sh
pnpm build
node scripts/bundle-size.mjs        # JSON: entry, first load, totals, every chunk
node scripts/bundle-size.mjs --md   # the summary table
```

- **Names:** chunks are listed without their content hash, so two builds compare line by line.
- **Units:** KiB (1024 bytes), one decimal.
- **Gzip:** level 9.
- **Entry:** the module script that `dist/public/index.html` loads.
- **First load:** the entry, plus its `modulepreload` links and its stylesheets.
- **Budget:** `pnpm test:smoke` fails when the entry chunk passes 925 KiB or 295 KiB gzip (its
  size after Wave 3 plus 5%). Raising it is a deliberate, explained edit.

| Entry chunk | KiB | KiB gzip |
|---|---:|---:|
| Before Wave 3 | 1068.7 | 334.3 |
| Zod kept to the settings page | 997.9 | 314.6 |
| Dialog bodies on demand | 880.8 | 280.9 |

All JS together: 444.8 KiB gzip before Wave 3, 441.5 with zod kept to the settings page, 451.4
with the dialog bodies on demand (38 chunks to 57): code shared by the parts loaded on demand
splits into chunks of its own. Those are fetched when the browser is free after
start, so the total transferred grows a little while the first load shrinks.

## Queries per scenario

Five scenario tests count the database queries of a piece of code, each at several sizes, so
both the count and how it grows are on record. They share one counter,
`api/testing/countQueries.ts`, which other tests also use for a single ceiling (storing 1200
notifications in `api/routers/notifications-insert.test.ts`, a sync of 1200 issues in
`api/routers/issues-sync-parity.test.ts`).

- **How queries are counted:** a spy on `PGlite.prototype.query` and on the `query` of each
  transaction (begin and commit included when drizzle sends them as queries). A test of the
  counter itself checks that one query counts as one, inside a transaction too.
- **Boundaries:** from the call of the measured function to its return. Setup before it and
  checks after it are not counted.
- **Ceilings:** each test's `MEASURED` holds the current numbers (the ones frozen on 2026-10-22,
  before Wave 2, are in its comment and below), and each test also checks the functional result.
  A change that lowers a count lowers its ceiling. Raising one is never a side effect: it is a
  deliberate edit, with the new measure and its reason in the commit (a correctness fix may need
  a query more).
- **What the counts prove:** fewer queries on PGlite. They say nothing about index use or
  latency on Postgres.

| Test | Scenario | Before Wave 2 | After Wave 2 |
|---|---|---|---|
| `api/sync/queries-per-pass.test.ts` | `syncEntries` over one page of N entries on the fake tracker: first read (all new), then a full re-read without a checkpoint (all known) | N = 10 / 20 / 40: 40 / 80 / 160, both passes (4 per entry) | 4 / 4 / 4, both passes |
| same | a pass where G of 40 entries are gone on the service | G = 5 / 10 / 20: 10 / 20 / 40 (2 per entry) | 2 / 2 / 2 |
| `api/queries/accounts-queries.test.ts` | `signOutEverywhere` for a user with S sessions, one kept, one other user's session and device present | S = 1 / 5 / 20: 2 / 6 / 21 (2 + one per session ended) | 2 / 2 / 2 |
| `api/sync/sinkDeletes-queries.test.ts` | `pushSinks` sending D deletes of one issue's entries to a day-totals sink (Everhour, mocked) | D = 1 / 5 / 20: 9 / 29 / 104 (4 + 5 per delete) | 9 / 9 / 9 (100 per pass at most; 150 take two passes of 9) |
| `api/routers/issues-sync-queries.test.ts` | a Jira sync (fetch mocked) of K issues assigned to the user: first sync (all new), then one where all K changed status | K = 1 / 5 / 20: 21 / 29 / 59 first (19 + 2 per issue), 22 / 34 / 79 changed (19 + 3 per issue) (frozen before the residuals mini-wave) | 21 / 21 / 21 first, 22 / 22 / 22 changed |
| `api/routers/issues-reassigned-queries.test.ts` | a Jira sync (fetch mocked) that finds K of the user's issues reassigned to someone else | K = 1 / 5 / 20: 22 / 34 / 79 (19 + 3 per issue) | 22 / 26 / 41 after Wave 2; 22 / 22 / 22 once its "unassigned" notifications are stored in one statement |

The results are also checked scenario by scenario against snapshots the per-row code wrote
before it was batched: the worklog feed in `api/sync/feedPage.test.ts`, a Jira sync's issues
and notifications in `api/routers/issues-sync-parity.test.ts`.

## Indexes (Wave 2)

`api/queries/indexes.test.ts` checks that the plan PGlite picks on a filled table uses them. A plan
shows an index is usable and chosen; it does not measure production latency.

- **Added:** `idx_outbox_worklog` on `outbox(worklog_id) WHERE worklog_id IS NOT NULL`
  (`drizzle/0005_outbox_worklog_index.sql`). For the ON DELETE SET NULL every worklog delete runs
  on outbox, held sink deletes, and the pending-change checks of the feed. The rows tied to no
  worklog (sink deletes due) are never looked up by it, so they are left out. Write cost: one
  index entry per queued operation that names a worklog, on a table that holds a queue.
- **Already there, kept:** `idx_outbox_connection_kind` (`0004`), used by the sinks pass and the
  Jira worklog sync.
- **Omitted:** `worklog_trash(user_id, connection_id, reason)`. Its one query runs per Jira
  worklog sync, over a trash purged after 30 days and already narrowed by the existing
  `(user_id, deleted_at)`; one more index entry on every delete is not worth it.
- **Omitted:** `worklogs(user_id, issue_key)`. The frequent queries also filter by
  `connection_id`, which the unique index's prefix `(user_id, connection_id, issue_key)` serves;
  only legacy fallbacks without a connection would use it, at one more entry per worklog written.

```sh
pnpm exec vitest run api/sync/queries-per-pass.test.ts api/queries/accounts-queries.test.ts \
  api/sync/sinkDeletes-queries.test.ts api/routers/issues-reassigned-queries.test.ts \
  api/routers/issues-sync-queries.test.ts \
  --reporter=verbose   # prints the [measure] lines
```

## React renders

`e2e/renders.test.mjs` counts React's work in the browser, page by page, with a timer running
and without, on the production bundle as it ships.

- **What is counted:** commits, and the components that rendered in each. Not render calls:
  those also include renders React throws away (StrictMode's double render, interrupted
  transitions), which say nothing about work done on screen.
- **How:** React calls a DevTools hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`) on
  every commit, production builds included. `e2e/renders.mjs` installs one as a page init
  script, before the app loads; nothing of it is in the app or its bundle.
  - A component rendered in a commit when it is new or did work (React's `PerformedWork`
    flag). A subtree React left as it was (its children the same fibers as before) is not
    walked.
  - Edges: a component whose function ran and then bailed out (nothing changed) is not
    counted; a `memo` around a forwardRef or class (tag 14) counts with its inner component,
    twice. The app's own `memo`s wrap plain functions (tag 15, counted once).
  - Each render is attributed to the region (`main`, `nav`, `aside`, a dialog) and element it
    draws, so a number can be traced to what ticks.
- **What it depends on:** React's internals, not a public API: the hook's `inject` and
  `onCommitFiberRoot`, fiber tags (components 0, 1, 11, 14, 15; host 5), the `PerformedWork`
  flag (1) and the `alternate` and `child` links. Checked with React 19.2 (the version in the
  lockfile). After a React upgrade the validation below runs first; if those internals moved, it
  fails and no app number is read until the counter is fixed.
- **Window:** five minutes of the page's own clock (Playwright's `page.clock`), stepped a
  second at a time; each step waits for the requests it started (the event stream, open by
  design, aside). Five minutes is the least common multiple of the app's fixed periods (the 1 s
  clock; polls every 15, 30 and 60 s; the timer heartbeat every 25 s), so each of those fires
  the same number of times in the window. That removes the phase of the fixed periods, not every
  effect of timing: a refetch started by something else (an event, an invalidation) restarts a
  poll's interval, and a response may land a step later. Real-time windows were tried first and
  rejected: a 10 s window holds a poll or not by chance.
- **Spread:** two runs agree within 2%; the limits allow for it.
- **Limits:** each scenario's limit is the most measured plus 2%. A change that lowers the work
  lowers the limit; raising one is a deliberate edit, with the new measure and its reason in the
  commit, never a side effect.
- **A window with the stream up:** the counts are defined with the event stream connected. On a
  loaded machine (the full e2e suite alongside) the stream has dropped during a window a few
  times (the page then polls timers every 5 s instead of 15 and refetches everything when it is
  back: up to 18491 renders where 9874 is normal), never on its own or in 7 real minutes. An init
  script counts the stream's errors and opens; a window in which either moved is not one, and
  up to three windows are measured: the first with the stream up and under its limit passes.
  Each window's message lists what the page asked for. A real regression is over in every clean
  window (checked by lowering a limit under the measure).
- **Validation, before any app number is read:** a fixture built in production mode
  (`e2e/fixtures/renders/app.jsx`) has a ticker committing once a second with a plain child, a
  memo child and a static sibling. In 10 s of real time, and in 30 stepped seconds, the ticker
  and its plain child must count one per second (±1; stepped, exactly 30 commits), the memo
  child and the static sibling 0, and nothing else. If it fails, the counter is wrong and the
  app's numbers are not used.
- **What it does not say:** time spent. A count is work done, not frames dropped or
  milliseconds; no claim on smoothness rests on it alone.

Each column adds its change to the ones before it (cumulative, in commit order).

| Scenario (5 min) | Before Wave 3 | Shared clock | Fetch time read on demand | Shell effects apart |
|---|---|---|---|---|
| Dashboard, no timer | 55 commits, 15221 renders | 41, 13840 | 41, 4620 | 40, 2889 |
| Issue page, timer running | 712 commits, 21929 renders | 366, 20452 | 366, 20452 | 367, 6044 |
| Dashboard, timer running | 1013 commits, 73998 renders | 366, 24399 | 366, 24399 | 366, 9883 |
| Timesheet, timer running | 1001 commits, 66823 renders | 366, 23704 | 366, 23704 | 367, 9296 |

## Zod in the client (method only)

Before any change to `contracts/`, measure which client chunks contain zod and which
`@contracts/*` modules bring it in.
- **How:** a one-off build with a Rollup plugin that writes the module graph to a scratch file.
  Nothing is committed to the Vite config.
- **What to read:** in that graph, follow every importer chain from a `zod` module up to its
  `contracts/` entry points.

## The full gate

```sh
pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke && PROVIDERS_READ_ONLY=1 pnpm test:e2e
```

- **Per-file counts** come from `vitest run --reporter=json` and from `node --test --test-reporter=tap`.
- **What baseline.md records:** results, counts per file, versions and sizes only.
- **What stays local:** raw logs and durations. They vary from run to run, so they are never
  committed.
