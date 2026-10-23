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
- Board groups come from the server (`group`), the same bucket that filtered them; a bucket
  switch publishes a `bucket` live event so the device's other tabs refetch.
- Starting work on a TODO starts now: no "from the gap" question (that dialog belongs to the
  timer's own Play).
- The tab title, favicon dot and tray stay for real timers only; a TODO's own time shows in the
  sidebar chip (dashed) and on its row.

## Batches
- [x] A Dashboard slim (dc23ded)
- [x] B Pinboard "Belongs to" (d472c5d): regression e2e failed first, at the other tab's switch
- [x] C TODO data model (d771c82)
- [x] D Capture without syntax (93f9c56)
- [x] E Timer double track (001c69c)
- [ ] F Period trend parallel series
- [ ] G Plan the day + suggestions
- [ ] H Live TODO post-it

## Verification
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke` | A–E, each batch | green (2159 tests after E) |
| `PROVIDERS_READ_ONLY=1 node --test e2e/{todos,board,renders,timer*,idle*}` | A–E | green; render budgets unchanged |

## Blocks and next action
- Next: batch F.
