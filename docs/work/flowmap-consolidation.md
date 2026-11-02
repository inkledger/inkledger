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
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` | full matrix | 311/311 on the committed tree. Earlier runs had two failures, both fixed: an axe check measured after a leftover scroll, and an Outlook pane race (see below). |
| `pnpm db:check` | migrations vs schema | ok |
| HEAD layout signature | never-customized user, 1400/1280/375 px | only difference: the new Workspace settings category |
| Regressions on the pre-fix snapshot | kernel, canonical, collector, import, flow | each new test fails before its fix |
| Visual | 320/375/1280 px, light and dark: Dashboard, Studio, history, "Use over time" | checked; fixed area order, scope row padding and tile contrast |

## Limits
- The service-level concurrency tests (prepare per tab, racing commits, single-use lease, read vs activation) were written after the change: the untracked files had no copy from before, so their failure on the old code is not proven.
- From then on, a snapshot (`scratchpad/snap1`) was used.

## Outside the workspace, found by the gate
- `e2e/outlook-addin.test.mjs` "the pane sends the copy where Outlook can" failed now and then, on HEAD as well.
- Cause: the pane treated the copy setting as "off" until `me` answered, so a pin made in that moment skipped the mail's copy without a word.
- Fixed in 38c24cd, with a deterministic regression test (the `me` answer is held until after the pin). The Outlook file then passed 6 out of 6 runs.

## Review 2 (1 Nov, after the commits)
Three independent read-only audits (kernel and server, client and UI, FlowMap/planner/tests) of `origin/main..HEAD`. Each finding was checked in the code; each fix has a regression test that failed before it, or is listed below as not reproduced.

Fixed (commits eb212fe, 72d0d5a, ae27d90):
- Kernel: a reorder checked only the first pinned block; timeline and summary were not hideable, so the legacy data migration threw at boot for anyone who had hidden them; FlowMap checksums and order depended on the server's locale; active days were UTC days.
- Server: a draft discarded by another tab could still be committed; "applied" was set on a newer draft revision; the draft compare-and-swap compared JSON text, so a FlowMap Delete (jsonb rewrite) left drafts that could never be saved; the boot purge never dropped idle presentations, finished drafts, old operations or imports; discovery marks lost updates; an oversized `.workspace` gave a 500; server-written flow events collided on their id; an unsupported scope gave a 500.
- FlowMap and planner: empty daily periods; forged control ids on exposure/discovery events; no throttle on aggregate, export and suggest, no cap on raw events, a prune on every batch; the model's order was dropped and "picked nothing" read as "unavailable"; feedback reported as saved with collection off; Delete kept planner feedback and suggestion data in drafts.
- Client: the Dashboard ignored where the Studio placed sections (rail, bands, desk hide); Customize built every tick on a stale layout, left drafts that blocked the next tick, changed one device only and flashed; a focused field removed without blur kept the typing task forever; a beacon was sent after opt-out; shared timer controls were counted as the sidebar's; missing label keys showed raw keys; Settings colours differed for everyone; planner lost the typed request, showed ids and raw numbers.
- Outlook: the copy could be the next mail's file, and it held the pane's buttons while waiting.

Not changed, with reason:
- Revision operations still accumulate: compacting them would change the fingerprints of layouts already presented. An export over 1024 operations is refused as too large, not with a 500.
- Descriptors are not purged: one row per distinct layout, used by "Use over time".
- Kernel helpers used only by tests stay (they check the real catalog); `src/lib/workspace/crypto.ts` stays as the browser half of the cross-platform digest tests.
- The forced interleaving "consent read, Delete, insert" is not unit-tested; consent is re-read under the flow lock (checked in the code).

Visual Layout editor (user request, 1 Nov), D-58:
- `contracts/workspace/sketch.ts` (re-exported by `src/lib/workspace/sketch.ts`, which adds the Tailwind heat tint) draws each page the way it is laid out (Dashboard desktop and phone, sidebar, phone tabs); the editor, "Use over time" and the server's file picture share it (`PageSketch`, `api/workspace/flowSvg.ts`); the editor's "Show use" lays `HeatOverlay` (tint, 8×8 click dots from `hitGridByAnchor`, counts on the 3 most used) over its blocks for a chosen period.
- Every block sits in its area with its eye, pin and ⋯ menu (size, up/down/start/end, move to); hidden blocks stay as dashed ghosts; locked ones say why.
- Drag by the handle with pointer events (mouse, pen, finger; `touch-action:none` only on the handle), live slot, inline refusal reason, edge auto-scroll; keyboard: Space, arrows, Enter, Escape, announced.
- Each change is drawn at once and replaced by the server's preview; "Now on the page" shows the applied layout.
- Two Dashboard scopes in the Studio; Customize changes both.

## Review 3 (1 Nov, on the user's own data and pages)
- A layout saved under older rules (the header timer hidden then shown, before C-01) no longer resolved: the whole saved layout was dropped and every new commit on it failed. Saved operations the current rules refuse are now set aside (listed as `isolated` fallbacks); drafts still follow today's rules. Found on the dev database, reproduced in `resolve.test.ts` and an e2e.
- The Studio's drawing did not match the pages: the rail is beside the timeline only, the summary sits beside My issues and Recent activity (stacked), the header stands beside the page title, the sidebar's timer sits before "Start timer". The Dashboard and every drawing of it now share one composition (`dashboardSegments`, `sidebarActionSegments`, `AreaBlocks`).
- No heat map showed because FlowMap had never been turned on (opt-in) and a period appeared only after the daily snapshot. Now: this week's use is worked out on the fly (stored nowhere) and shown at once in "Use over time" and on the editor's blocks ("Show use"); with FlowMap off the editor says so and leads to its switch.
- One unreadable stored event made every map fail: such rows are now skipped.

## Status
Complete: the full gate is green on the committed tree after review 2 and the editor (lint, check, 2700 unit, build, smoke 924.1/293.8 KiB within 925/295, 317/317 e2e, db:check). One unrelated e2e (timesheet dialog height) measured mid-animation under load; fixed in its own commit. The commits are local, not pushed.
