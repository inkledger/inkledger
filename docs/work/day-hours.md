# State: Hours of the day (per-day schedule, breaks respected when logging) — in progress

## Goal and done criteria
- Any day (past, today, future) can have its own hours (start, end, breaks, day off) overriding the weekly schedule version.
- New time is placed around the day's effective breaks: time that would cross a break is split into worklogs on the same issue; on past days a block that would start in a break starts at its end.
- Edited by dragging on the Dashboard day timeline (desktop, explicit edit mode) or with a fields form (phones, and as the non-drag alternative everywhere).
- When the work length changes, the user picks: keep the target (move the end) or keep the hours (target changes).
- Suggestions "it was my break": away dialog, day review, under the timeline.
- Changing the weekly schedule asks whether to keep or drop the future day overrides it covers.

## Constraints and out of scope
- Planned entries convert verbatim. No server validation of worklogs against breaks. Timer segments are not stored.
- Branch `feat/day-hours` in a worktree. The main checkout has uncommitted team work touching `team.ts` and `api/parity/*`, so parity is regenerated after that lands.
- Migration 0039 (`work_day_overrides`). The desk notes also name 0039 for note-issue links, so renumber at merge if that lands first.

## Decisions
- Resolution: `scheduleFor(day, versions, overrides)` swaps the weekday slot for that date (`withDay`). Helpers stay unchanged.
- Placement (`contracts/placement.ts`): break-aware chain fill backwards from now / the stop, and appending after a break on past days. A part never spans another entry. A break still running at the end counts as worked (the 13:30 case). When nothing fits, it falls back to one piece and says `overBreak`. A timer that ran without a pause (`timers.list.unbroken`, or running since its start) stays in one piece.
- The existing placement test "does not cover a block ending a few seconds past the minute" now expects 12:30 (before lunch) instead of 13:30 (inside lunch): intended.
- Writes: `worklogs.create` takes `parts` (2–5, in order, summing to `seconds`). All parts are checked before anything is written; the timer is claimed once; a failing part gives back only what was not written (`claim.undo(back)`).
- Save choice: asked only when the draft's work differs from the day's current hours; "keep" targets the week's hours (`keepTargetEnd(base, draft)`).
- Edit mode: an explicit button, an inert and dimmed band, handles in a sibling layer, a 4 px threshold, Esc to cancel, Enter to save, and Undo in the toast. Leaving the day with a draft asks first (`useDirtyClose` on period navigation). Phones (<640 px) get the fields sheet only.
- Not done: workspace catalog `control()` entries for the new buttons (instrumentation is optional).

## Batches and progress
- [x] 1 contracts + DB (`work_day_overrides`, migration 0039)
- [x] 2 API (`days`/`saveDay`/`removeDay`, `save.overrides`, `create.parts`, `schedule` live event, team/forecast/SSR)
- [x] 3 FE resolution (`useWorkSchedule` with overrides, holes wait for them, live sync, timer, mods)
- [x] 4 split placement UI (LogTimeDialog, QuickLog, DayReview, Timesheet duplicate, pending timers)
- [x] 5 day hours editor (DayHoursEditor, useDayHoursEdit, dayHours)
- [x] 6 suggestions + settings (IdleDialog "It was my break", BreakSuggestion, own days list, keep/drop dialog)
- [x] 7 e2e (`e2e/day-hours.test.mjs`, 4 tests) + full checks

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm lint` / `pnpm check` | all + design | pass |
| `pnpm test` | 263 files, 2914 tests | pass |
| `pnpm build`, `pnpm test:smoke` | all | pass |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` (first run) | 375 tests | 1 failure: `renders.test` dashboard with a timer over budget (10847 vs 10252) |
| fix: memoized edit state and bar, sheet/confirm/suggestion mounted only when used | renders + related e2e | renders 10144; one flaky failure (install page teardown, "Request context disposed") that passes when rerun alone |
| `pnpm test` after the fix | all | pass |

## Blocks and next action
- Status: done in worktree `feat/day-hours`, not committed.
- The full e2e was not run again after the render fix; only renders, day-hours, dashboard-day, day-review, regressions, layout-overflow and a11y were rerun.
- At merge: the main checkout's team work touches `team.ts` and `api/parity/*`. Land that first, rebase, run `pnpm parity:update` again, and check that migration 0039 is still free.
- Not covered by e2e: a timer placed across the break in the UI (covered by unit and router tests).
