# Status: FlowMap / Adaptive Workspace consolidation

## Goal and done criteria
Close the Workspace/FlowMap work (studio/flowmap-adaptive-workspace.md, Phases 0–6, uncommitted) so it is safe to commit:
- defects found by the 1 Nov audit are fixed, each with a regression test;
- a user who never customized gets exactly the HEAD (c8e2ac3) app, with no workspace requests or writes;
- the gate is green: `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke && PROVIDERS_READ_ONLY=1 pnpm test:e2e`;
- commits are grouped, with no push.

## Constraints and out of scope
- No new surfaces (D-17).
- No rewrite of existing migrations: new schema goes in 0035; renaming 0027–0034 changes only file name and journal tag.
- Dev :3000 only; `PROVIDERS_READ_ONLY=1`.

## Decisions
- Runtime only when customized: `settings.get` returns `workspace: { scopes, flowMap }`. Without a stored revision for the scope and with FlowMap off, the client renders the bundled ProductDefault and makes no request. SSR prefetches only customized scopes.
- GET writes nothing, except a tab's first presentation of a live scope (once, so acks and events have a proof). Pruning moved to the boot purge (`api/workspace/purge.ts`).
- Presentation writes are a compare-and-swap under the per-scope apply lock (`writePresentation`), commit included. This makes the lease single-use and stops a read from undoing an activation.
- The prepared revision is loaded by `prepareId` (one per tab).
- A lost commit race returns the stored revision with no lease (`replayedCommit`).
- Legacy `settings.dashboard` is seeded once as the first revision of both Dashboard scopes (data migration `dashboard-layout-to-workspace`, hides only, as HEAD). In HEAD only visibility mattered.
- Default identical to HEAD:
  - header with timer before period;
  - My issues + Activity in one `min-w-0` column;
  - no Notifications tile in More;
  - Settings colours as before;
  - nav gap of 12px;
  - `--bottom-nav-h` set through CSS (`data-tab-density`), so wide screens and the soft keyboard still zero it.
- Kernel:
  - an anchor holding a critical control is critical (C-01: `dashboard.headerTimer`);
  - a pin constraint blocks move, reorder, hide and unpin, not variant (D-55);
  - pinned placements change only by the user;
  - a reorder must list the area's visible anchors exactly;
  - a second non-user change to the same anchor attribute in one draft is a conflict;
  - tombstones apply to reorder and constraints;
  - code-unit ordering throughout;
  - canonical JSON normalizes keys to NFC before sorting and refuses collisions.
- Kept as designed (D-50): an activation never acknowledged blocks the next commit of that tab until "Present committed layout" reconciles it (existing test `applyMachine.test.ts` "requires reconciliation…").
- Rollback leaves alone the anchors that the target does not know, and revokes the user's constraints made after the target (D-51).
- Planner:
  - request translation picks among enumerated `request-N` options (D-53), deduplicated, without pinned or fixed anchors, and only options that resolve and change the layout;
  - intent and proposed constraints must refer to the selection;
  - the suggestion signature no longer includes the evidence id (no nagging after new evidence).
- Retention: `purgeFlowRetention` applies every user's windows at boot purge, FlowMap on or off.

## Batches and progress
- [x] 0 Gate back to green:
  - migration replay test;
  - PlannerPanel lint;
  - eval script in tsconfig;
  - `.claude-tmp/` deleted (user OK);
  - e2e never reaches a real Ollama.
- [x] 1 Parity for non-customized users:
  - runtime gating, read-only GET, visible diffs, Dashboard, Customize, legacy migration;
  - HEAD layout signature: the only difference left is the Workspace category.
  - Kept on purpose:
    - the a11y colour fix on the active Settings category (HEAD fails AA there);
    - the More Notifications tile, only once the user placed it.
- [x] 2 Kernel: C-01, pin, pinned, reorder, duplicates, rollback, tombstones, determinism, superseded activation.
- [x] 3 Server apply:
  - prepare by id, compare-and-swap writes, single-use lease, commit retry;
  - 0035 scope keys and opaque column, opaque digest check, bounded inputs;
  - epoch after prune: left as is (pruning only drops `unknown` rows older than 24 h; recorded as a risk).
- [x] 4 Routers:
  - shared `guard`;
  - translated `server.workspace.*` messages;
  - rate limits on model, imports and ingest;
  - auth, isolation and loop tests.
- [x] 5 Planner WIP: request-N options, constraint checks, signature; fixtures moved to the primary area.
- [x] 6 Import and FlowMap:
  - read-only unknown content through prepare and commit;
  - `.flowmap` origin forced, SVG redrawn, consent required;
  - Delete strips evidence refs;
  - retention purge.
- [x] 7 Client:
  - dirty released when the field is gone or empty;
  - time dialogs inside the boundary;
  - apply steps check the interaction epoch;
  - collector flushes on dispose and keeps the pending action.
  - Mobile flash: SSR prefetch of `dashboard/mobile` plus `keepPreviousData`; the initial device class stays desktop for hydration.
  - The ideas e2e was a stale fake (`issues.createFields`, from 0216986), not cece5f4.
- [x] 8 Studio UI and copy:
  - names instead of ids (areas, controls, history by date);
  - plain en/it copy; `Chip`, `ActionRow`, danger tokens;
  - no `<code>`, area select shows its value.
- [x] 9 E2E: `e2e/workspace-guarantees.test.mjs`, plus weak assertions fixed in workspace, flowmap and a11y (axe waits for animations to settle).
- [x] 11 "Use over time" (user request, 1 Nov), D-57: see the decision below.
- [x] 10 Full gate and visual check; grouped commits (no push).

## "Use over time" (D-57)
- A carousel of one map per period at the top of the FlowMap panel, shown at once and drawn client-side from the period's evidence and its layout (`flowMap.get.layouts`).
- The periods come automatically from a daily snapshot of the last 7 days (`snapshotFlowEvidence`, boot purge every 6 h), only for users with FlowMap on and new events.
- Tests: unit `flowService.test.ts`; e2e `flowmap.test.mjs` "Each page's use over time…".

## Verifications
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm lint` | repo + design check | clean |
| `pnpm check` | typecheck | clean |
| `pnpm test` | unit | 2668/2668 |
| `pnpm build` | bundle | ok |
| `pnpm test:smoke` | server + first-load | ok; 922.0 KiB, 293.0 KiB gzip (limits 925/295 unchanged: the catalogue checks moved off the client) |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` | full matrix | 309/310. The one failure (axe target-size measured after a leftover scroll) was fixed in the test, then 26/26 workspace/flowmap/a11y/guarantees passed. |
| `pnpm db:check` | migrations vs schema | ok |
| HEAD layout signature | never-customized user, 1400/1280/375 px | only difference: the new Workspace settings category |
| Regressions on the pre-fix snapshot | kernel, canonical, collector, import, flow | each new test fails before its fix |
| Visual | 320/375/1280 px, light and dark: Dashboard, Studio, history, "Use over time" | checked; fixed area order, scope row padding and tile contrast |

## Limits
- The service-level concurrency tests (prepare per tab, racing commits, single-use lease, read vs activation) were written after the change: the untracked files had no copy from before, so their failure on the old code is not proven.
- From then on, a snapshot (`scratchpad/snap1`) was used.

## Blocks and next action
- None. Next: full gate, visual check on dev :3000, grouped commits (no push).
