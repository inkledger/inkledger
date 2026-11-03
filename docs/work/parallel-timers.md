# Status: parallel timers, with a split of the overlapping time

## Goal and done criteria
- Play while another timer runs: dialog "Running: A · 1 h 12 min — Start B? [Switch] [Run both]". Enter = the last choice made on this device.
- Running timers: a compact list in the sidebar (key, time, Pause, Stop); paused ones in Quick start as today.
- Log time: "Alone / With B 40 min [60]% → 24 min / To log". Default is an equal share; the next timer gets the remainder (editable). With 3+ timers, 1/N.
- Worklogs placed "where they ran", tiled (A 9:00–10:44, B 10:44–11:30).
- Discard A → B gets all of the overlap. Total above 100% allowed, with a warning. overlapPolicy=block → Run both disabled.

## Constraints and out of scope
- Time writes only through `api/sync/timeWrites.ts`; frozen API contract (`api/parity`), so inputs stay optional and outputs are additive only; migrations never rewritten; i18n en+it; tests with `PROVIDERS_READ_ONLY=1`.
- Branch `feat/parallel-timers` in the worktree `../jira-time-tracker-parallel` (main has others' uncommitted work in AppLayout/Dashboard/parity).

## Decisions
- `timer_runs` keyed by issue identity (not an FK): runs outlive the timer row deleted at log time, as long as they share time with an unlogged run.
- `timer_shares` in basis points (exact 1/3); the default of a stretch = (10000 − shares already recorded) / participants with no recorded share.
- Run time short of tracked time (legacy timers, undo) counts as "alone".
- Idle: away time trims every timer running on this device. Sidebar: max 3 rows + "Show all N". Single-timer surfaces (tray, module API, screensaver, focus, title) show the most recent timer.

## Batches and progress
- [x] 1. `contracts/timerSplit.ts` + tests; schema `timer_runs`/`timer_shares` + migration 0041; `api/queries/timerRuns.ts`
- [x] 2. Record runs in every lifecycle path; TODO session per issue; heartbeat for all; prune
- [x] 3. Server API: `start.mode`, block, `switchedFromAll`, `timers.split`, `list.defaultSeconds`, `worklogs.create.split` + undo; parity
- [x] 4. Client foundations: `timerFocus` + single-timer sites, `switchedFromAll`, `defaultSeconds`, live Dashboard per timer
- [x] 5. Switch / Run both dialog + harness
- [x] 6. Compact list in sidebar/rail/tab bar/title; idle on all timers
- [x] 7. Split UI in Log time + tiled placement
- [x] 8. e2e + full checks + docs

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm vitest run contracts/timerSplit.test.ts api/queries/timerRuns.test.ts src/lib/timerFocus.test.ts` | split, runs, focus | ok |
| `pnpm vitest run api/routers/timers-parallel.test.ts` | alongside, block (only with another running), held, heartbeat, TODO per issue, 60/40 split, discard | 8/8 ok |
| `pnpm parity:update` | start.mode, split, worklogs.create.split, list.overlap/defaultSeconds, switchedFromAll, i18n | updated |
| `pnpm check && pnpm lint && pnpm test` | all | ok, 3112/3112 |
| `PROVIDERS_READ_ONLY=1 pnpm test:smoke` | build | ok |
| `PROVIDERS_READ_ONLY=1 node --test e2e/parallel-timers.test.mjs` | Run both, Enter remembered, block, 60/40 split tiled | 2/2 ok |
| `PROVIDERS_READ_ONLY=1 node --test 'e2e/*.test.mjs'` | all | 429/430; the 1 (regressions: Play with a timer running) updated to the new question, rerun ok |

## Blockers and next action
- Status: completed in the worktree, verified. Next: commit + merge into main only with the user's OK.
- Found along the way: on the Dashboard a stopped timer of a key with "#" (GitHub, acme/web#1) couldn't be opened from the timeline (`logPending` split the id on the first "#"): fixed here, also to bring to main.
- Notes: the runs follow a key change (`api/sync/issues.ts` moveDependents); the migrations test drops timer_runs/timer_shares like every later migration.
