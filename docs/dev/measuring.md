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
| Routes | `routes.json` | Every `<Route path>` of `src/App.tsx` (read with the TypeScript parser) and the layout route guarding it (`RequireAuth`, `GuestOnly` or none) |
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

**Compatibility runs in two directions:**
- **Inputs:** each `FrozenIn[p]` must be assignable to the current input. The server still accepts
  everything an old client sends.
- **Outputs:** each current output must be assignable to `FrozenOut[p]`. An old reader still reads
  what the server returns.

A break in either direction stops `pnpm check`.

## Bundle size

```sh
pnpm build
node scripts/bundle-size.mjs        # JSON: entry, first load, totals, every chunk
node scripts/bundle-size.mjs --md   # the summary table
```

- **Names:** chunks are listed without their content hash, so two builds compare line by line.
- **Gzip:** level 9.
- **Entry:** the `<script type="module">` of `dist/public/index.html`.
- **First load:** the entry, plus its `modulepreload` links and its stylesheets.

## Queries per scenario

Four tests count the database queries of a piece of code, each at several sizes, so both the
count and how it grows are on record. They share one counter, `api/testing/countQueries.ts`.

- **How queries are counted:** a spy on `PGlite.prototype.query` and on the `query` of each
  transaction (begin and commit included when drizzle sends them as queries). A test of the
  counter itself checks that one query counts as one, inside a transaction too.
- **Boundaries:** from the call of the measured function to its return. Setup before it and
  checks after it are not counted.
- **Ceilings:** each test's `MEASURED` holds the current numbers (the ones frozen on 2026-10-22,
  before Wave 2, are in its comment and below). A change may lower them, never raise them; each
  test also checks the functional result.
- **What the counts prove:** fewer queries on PGlite. They say nothing about index use or
  latency on Postgres.

| Test | Scenario | Before Wave 2 | After Wave 2 |
|---|---|---|---|
| `api/sync/queries-per-pass.test.ts` | `syncEntries` over one page of N entries on the fake tracker: first read (all new), then a full re-read without a checkpoint (all known) | N = 10 / 20 / 40: 40 / 80 / 160, both passes (4 per entry) | 4 / 4 / 4, both passes |
| same | a pass where G of 40 entries are gone on the service | G = 5 / 10 / 20: 10 / 20 / 40 (2 per entry) | 2 / 2 / 2 |
| `api/queries/accounts-queries.test.ts` | `signOutEverywhere` for a user with S sessions, one kept, one other user's session and device present | S = 1 / 5 / 20: 2 / 6 / 21 (2 + one per session ended) | 2 / 2 / 2 |
| `api/sync/sinkDeletes-queries.test.ts` | `pushSinks` sending D deletes of one issue's entries to a day-totals sink (Everhour, mocked) | D = 1 / 5 / 20: 9 / 29 / 104 (4 + 5 per delete) | 9 / 9 / 9 (100 per pass at most; 150 take two passes of 9) |
| `api/routers/issues-sync-queries.test.ts` | a Jira sync (fetch mocked) of K issues assigned to the user: first sync (all new), then one where all K changed status | K = 1 / 5 / 20: 21 / 29 / 59 first (19 + 2 per issue), 22 / 34 / 79 changed (19 + 3 per issue) (frozen before the residuals mini-wave) | — |
| `api/routers/issues-reassigned-queries.test.ts` | a Jira sync (fetch mocked) that finds K of the user's issues reassigned to someone else | K = 1 / 5 / 20: 22 / 34 / 79 (19 + 3 per issue) | 22 / 26 / 41 (the refresh is fixed; its "unassigned" notifications, one per issue, are not part of it) |

The feed's result is also checked scenario by scenario in `api/sync/feedPage.test.ts`: its
snapshots were written by the per-entry code before Wave 2, and the batched code ends the same.

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
npx vitest run api/sync/queries-per-pass.test.ts api/queries/accounts-queries.test.ts \
  api/sync/sinkDeletes-queries.test.ts api/routers/issues-reassigned-queries.test.ts \
  --reporter=verbose   # prints the [measure] lines
```

## React renders (method only, not yet a gate)

This method is recorded for later use. It becomes a gate only after its own check passes.

- **Method:**
  - A test build exposes a `<Profiler>` count per named subtree, behind a flag only the e2e
    build sets. The production bundle never contains it, which is checked by searching the
    built chunks.
  - A Playwright page script reads the counts after a fixed time with a timer running, under
    an e2e harness clock.
- **Validation before use:** a component known to re-render once a second must count about 60
  renders in 60 seconds, and a static component must count 0. If either fails, the harness is
  wrong and its numbers are not used.

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
