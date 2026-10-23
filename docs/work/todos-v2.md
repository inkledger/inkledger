# Status: Dashboard slim, pinboard "Belongs to", TODO v2

In progress (2026-10-23). Follows `docs/work/todos.md` (closed).

## Goal and completion criteria
- Dashboard has no TODO or "For you" cards; badges carry the counts.
- Changing a pinboard's "Belongs to" never leaves boards in the wrong switcher group or notes of
  another board.
- TODOs: captured with visible controls (syntax only as a shortcut), tied to the timer (double
  track), planned each morning in the TODO panel, suggested from the catalogue, pinnable as live
  post-its, with priority, estimate/spent, steps and recurrence. TODO time shows in parallel in
  "Period trend" and never counts as real time.

## Constraints and out of scope
- Parity contract changes stay additive. No new notification kinds (bell unchanged).
- No push, no prod access, test servers with `PROVIDERS_READ_ONLY=1`.
- Jira mentions are not suggested: comments are not in the catalogue.

## Decisions
- Shadow (TODO without issue) time lives in `todo_sessions`, never in timers or worklogs.
- Sessions keep a label snapshot and survive a TODO delete (chart stays truthful).
- Board groups come from the server (`group`), the same bucket that filtered them.

## Batches
- [ ] A Dashboard slim
- [ ] B Pinboard "Belongs to"
- [ ] C TODO data model
- [ ] D Capture without syntax
- [ ] E Timer double track
- [ ] F Period trend parallel series
- [ ] G Plan the day + suggestions
- [ ] H Live TODO post-it

## Verification
| Command | Scope | Result |
| ------- | ----- | ------ |

## Blocks and next action
- Next: batch A.
