# Status: virtual scroll for Quick start, ⌘K and the issue pickers

## Goal and done criteria
- The 3 searchable lists draw only the rows in view (`@tanstack/react-virtual` 3.14.21): with 2000 issues, opening and every keystroke go from ~230 ms / ~115 ms (prod) to tens of ms.
- Same results, order and keys as cmdk 1.1.1 (ranking `defaultFilter`, sections in their order, first option after every search, ↑↓ ⌘↑↓ Alt↑↓ Home End Ctrl+N/J/P/K Enter, ⌘Enter in Quick start), plus PageUp/PageDown.
- ARIA combobox: `aria-activedescendant` always on a drawn option, `aria-setsize`/`aria-posinset` over the whole list, the section as `aria-describedby`.

## Constraints and out of scope
- NoteActions (MoveDialog) stays on cmdk (a short list); the Outlook pane has its own picker.
- Same option names and roles the e2e tests use; only `same-key` changes its selector (`[role=option][aria-selected=true]`).

## Decisions
- Pure model `src/lib/commandRows.ts` (filter/order/keys, unit tests), component `src/components/app/VirtualCommand.tsx`.
- ⌘K: entries as data (id, search, keywords = the shortcut shown, view, run); `AddToDeskCommand`/`MoveTimerCommand` → hooks.
- `CommandDialog` removed from `ui/command.tsx` (no users left).

## Batches and progress
- [x] 0. Worktree `feat/virtual-command`, dependency
- [x] 1. `commandRows.ts` + tests
- [x] 2. `VirtualCommand.tsx` + i18n `ui.command.results`
- [x] 3. IssuePicker
- [x] 4. Quick start
- [x] 5. ⌘K
- [x] 6. e2e `virtual-lists`, docs, measurements, full checks (full e2e running)

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm vitest run src/lib/commandRows.test.ts` | ranking, order, keys | 11/11 ok |
| e2e desk, desk-flow, todos, notes, timesheet-day, day-hours | IssuePicker | 43/43 ok |
| e2e ideas, layout-overflow, mail-*, notes, same-key, search-memory, timer-lock, workspace-*, screensaver, ui-density, regressions, todos, desk*, timesheet-day, day-hours | ⌘K, Quick start, pickers | 194/199; 2 ideas + mail-pins fixed (the command typed by name: rows out of view aren't drawn); the 3 mail-copies fail on main too ("Copy saved" on the issue page) |
| e2e `virtual-lists` (2000 issues) | DOM < 60 options, setsize, every key, Enter, ⌘K at the end of the list, picker 320 px, axe | 3/3 ok |
| scratchpad perf/qs-virtual.mjs | Quick start, 2000 issues | opening 36–63 ms prod (was 220–270), 14 characters 0.22–0.28 s (was 1.6 s); dev 55–63 ms / 0.40–0.45 s (was ~600 ms / 3.2 s); same results (317) |
| `pnpm check && pnpm lint && pnpm test`, smoke | all | ok, 3097/3097 |

## Blockers and next action
- Seen along the way, not fixed (outside this work): the dialogs' close button is 14 px (WCAG 2.2 wants 24 px); the mail-copies tests fail on main.
- Next: the full e2e, then commit + merge with the user's OK.
