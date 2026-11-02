# State: Hours of the day (per-day schedule, breaks respected when logging) — done

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
- [x] 7 e2e (`e2e/day-hours.test.mjs`, 5 tests) + full checks

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
- Done: rebased onto main after the team heat map (fa15879), then merged into main on 2026-11-02.
- Checks after the rebase: lint, check, test (2971), build and smoke all passed. Full e2e: 393 of 394 passed; desk-snap failed once under load and passes when rerun alone.
- A stopped timer across the break: e2e checks the dialog's preview and the one `create` with both parts (the server is read-only toward Jira there; the split write is in the router tests). `e2e/day-hours.test.mjs`: 5 of 5 pass.

## Review pass (2026-11-02, after the merge)
Two independent reviews of 006f898 (server and frontend). Fixed, each with a test that failed before:
- Placement: a free stretch starting inside a break was chained to the one before it, so a split could jump over another worklog (`workPieces` links only work just before the break in the same stretch).
- Placement: a piece under a minute (durations not in whole minutes) made the server refuse the whole log: `foldShort` runs it into its neighbour, within the sub-minute tolerance.
- "It was my break": offered in a closed week, and the timer was trimmed before the break was saved (time lost when the save failed). Now hidden in a closed week (or while unknown) and saved first.
- `breakAt`: an absence reaching the day's start or end (arrived late, left early) clamped into a break and could drop lunch; now not a break.
- Editor: handles clamped to the drawn axis; the axis of a day off follows the draft; one Undo toast per day (Undo always one step back); Enter ignored while saving; edge grips 44 px on touch screens and fields `h-touch` there; Escape in a text field no longer drops the draft.
- Left as is: the hours button is enabled while the week's status loads (the server refuses a closed week's save); a short break (≲10 min) is covered by its edge grips on touch, so it is moved by its edges, keys or fields.
- New e2e: past day with its own break (2 h after it), "It was my break" (saved + timer trimmed), closed week (no button). `e2e/day-hours.test.mjs`: 8 of 8.
- Unrelated: `api/modules/modules.test.ts` "no private key is ever committed" failed on main at a954351 (a desk fixture); fixed on main by 12e4a80.
