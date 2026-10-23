# Status: Dashboard slim, pinboard "Belongs to", TODO v2

Done (2026-10-23). Not pushed. Follows `docs/work/todos.md` (closed).

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
- [x] F Period trend parallel series (8b2d8dd, b04fb80)
- [x] G Plan the day + suggestions (6c35e5f)
- [x] H Live TODO post-it (5d2086f)

## Verification
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke` | A–E, each batch | green (2159 tests after E) |
| `PROVIDERS_READ_ONLY=1 node --test e2e/{todos,board,renders,timer*,idle*}` | A–E | green; render budgets unchanged |
| `pnpm lint && pnpm check && pnpm test && pnpm test:smoke` | F–H | green (2163 tests) |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` | everything, after H | 158/158 green |
| Screenshots through the e2e harness (read-only, seeded) | Dashboard week/day, TODO page desktop/mobile, pinboard | checked; day axis fixed after it |

## Limits
- Suggestions per device: "Not now" is kept on this device only, until the next day.
- Jira mentions are not suggested (comments are not in the catalogue); other trackers' inbox ones are.
- A TODO started from its row starts now (no "from the gap" question).
- Dev :3000 not restarted here: migration 0009 applies on its next start (dev db only).

## Blocks and next action
- None. Next: the user's visual OK on dev, then push when told.
