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

## Queries per sync pass

`api/sync/queries-per-pass.test.ts` counts the database queries of one pass of the worklog feed.
- **Setup:** 20 entries on the fake tracker, one page.
- **Three passes:**
  - **all new:** the first read;
  - **all known:** a full re-read with no checkpoint, where every entry is already ours;
  - **five gone:** five deleted on the service.
- **How queries are counted:** with a spy on `PGlite.prototype.query`, and on the `query` of each
  transaction. A first test checks the counter itself: one query counts as one, inside a
  transaction too.
- **Ceilings:** the baseline's numbers are the test's `CEILING`. A change may lower them, never
  raise them.

```sh
npx vitest run api/sync/queries-per-pass.test.ts --reporter=verbose   # prints the [measure] line
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
