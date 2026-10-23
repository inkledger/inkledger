# Status: Board priority filter, room for cast shadows, TODO list

Done (2026-10-23). Not pushed.

## Goal and completion criteria
- The Board filters by priority, several levels at once, kept in the URL.
- With the Shadow mod on, no clipping container cuts a surface's shadow, and the layout does
  not move.
- A TODO list exists:
  - it is reached from anywhere with D, the bottom-right hot corner, the palette, a page, and on
    phones with a header button and a tile in More;
  - each TODO can be planned for a day;
  - each can be tied to an issue, a comment or a private note, and created from them;
  - reminders show in the bell and on the Dashboard.

## Constraints and out of scope
- The Shadow mod is untouched. It is signed, and rebuilding it is the user's step. The host reads
  its `--sh-1` instead.
- The `notifications` table and its sync are untouched: reminders are read from `todos`.
- No push, no dependency changes, no prod access.

## Decisions
- **Key D.** T stays the timer, and `g d` still goes to the Dashboard.
- **Reminders.**
  - They are in-app only: the bell section, the badge, one toast a day, and a Dashboard widget.
  - "Today" is the device's day, sent with each read.
- **Room for shadows.** `cast-room-x` / `cast-room-y` use `--surface-reach-*`.
  - `--room-*` is registered with `inherits: false`.
  - Vertically, the base room is plain padding.
  - The Board's column gap grows with a long left shadow.
- **One floating panel** (`FloatingPanel`) serves both the pinboard and the TODO list. Esc from a
  field closes only the TODO list.
- **Data integrity.** A TODO follows its issue's key changes, because the migration redefines
  `inkledger_issue_keyed`. There is no `fill_connection` trigger, and a CHECK keeps an issue key
  together with its connection.

## Batches
- [x] `feat(board): filter by priority`
- [x] `fix(ui): room for surface shadows`, plus `fix(ui): cast room never inherited or shifting`
- [x] `feat(todos): table and router`
- [x] `feat(todos): list, widget, D and hot corner`
- [x] `feat(todos): from comments, notes and menus`
- [x] `feat(todos): reminders and dashboard`
- [x] `feat(todos): mobile access`
- [x] Audit: `fix(todos,ui): audit findings`
- [x] Render budgets raised deliberately (TODO nav link, issue TODOs, reminders poll), in 3 test
      commits.

## Verification
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke` | full | green, 2151 unit tests |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` ×2 | full | see the final gate in the report |
| `e2e/shadow-room.test.mjs` | shadow room, layout, hit test | green |
| `e2e/todos.test.mjs` | TODO flows | green |

## Limits
- The sidebar can keep at most 12px of room per side, its own padding. A longer shadow there is
  trimmed at the window's or the aside's edge.
- A TODO made from a comment keeps a snapshot of its first line. Edits to the comment don't
  change it.
