# State: Desk (issues side by side) — partial

## Goal and done criteria
`/issues/desk` shows up to 4 issues at once, tiled like snapped windows: halves, thirds, one big pane with two beside it, or quarters.

Done criteria:
- Panes are placed with snap zones, by pointer and by keyboard, and resized with dividers.
- A compact issue detail fits each pane's width.
- A Compare view lines the key fields up across panes.
- Decision tools:
  - copy all issues for a model;
  - a decision note linked to every issue;
  - bulk status and log time;
  - named saved desks.
- On phones, one pane at a time behind tabs.

## Constraints and out of scope
- **Testing:** e2e tests run with `PROVIDERS_READ_ONLY=1`. Every time write goes through `api/sync/timeWrites.ts`, with no bulk write path.
- **Load:** the Desk code is lazy, and the first load stays at or below 925/295 KiB.
- **Migrations:** only new ones are added (0038 `desks`). The next one is 0039, for the note-issue links.
- **Language:** English only in code and docs; every string in en and it.

## Decisions
- **Layout model:** fixed arrangements plus the size of each track, not a tree. It lives in `contracts/desk.ts`, which is pure and shared with the server. Slot i of the arrangement holds pane i. A desk too small for the chosen arrangement draws a fitting one, but the saved arrangement is kept.
- **Issue detail:** `src/components/issue/IssueBody.tsx` serves both the page and a pane. A pane sizes itself to its own width through `data-pane-size` (a ResizeObserver), because the container-queries plugin is not available offline. A pane listens for keys only while it is active, loads its heavy sections when scrolled into view, and marks the issue seen once the pane is visible.
- **Storage:** the current desk is stored server-side in `desks` (`name` null). The page applies changes at once and saves after 300 ms of quiet, and on pagehide.
- **Snapping:** `useSnapDrag` does pointer and keyboard dragging with a small store, so panes never re-render while the pointer moves. A pane's scroll position is restored after a move. `snapTargetAt` can be reused for drops from outside the desk with n+1 panes.
- **Hotkeys:** Alt+Shift+arrows snap a pane; `useHotkeys` no longer treats Alt+Shift+←/→ as back/forward.

## Batches and progress
- [x] 0. Layout model (`contracts/desk.ts`, tests)
- [x] 1. `IssueBody` as page or pane; the issue page is unchanged (byte-identical screenshots)
- [x] 2. Desk page: current desk, layouts, dividers, parking tray, maximize, phone tabs, `g e` / `1`–`4` / `x`
- [x] 3. Snapping by drag, keys or menu ("Move to", "Swap with"); live region announcements
- [ ] 4. Entry points: Shift-click on issue links, "Open beside", dragging from lists and the board, multi-select in Issues
- [ ] 5. Compare view, and its phone table
- [ ] 6. Copy all for model (`issues.copyForAgentMany`)
- [ ] 7. Decision note (`markdown_note_issues`, migration 0039)
- [ ] 8. Bulk status and log time (`planBulkTransition`, `backToBack`)
- [ ] 9. Saved desks (list, save, open, rename, remove)

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm lint && pnpm check` | batches 0–3 on main | pass |
| `OLLAMA_URL= pnpm test` | all unit tests | 2872 pass (before batch 3); 2869 in the batch 3 worktree |
| issue e2e (renders, a11y, layout-overflow, issue-links, transitions, worklogs, keyboard-list, issue-copy, …) | batch 1 | 45/45 |
| `e2e/desk.test.mjs` + `e2e/desk-snap.test.mjs` | batches 2–3 | 8/8, ×3 |
| `PROVIDERS_READ_ONLY=1 pnpm test:smoke` | first load | 859.2/273.3 KiB (batch 2) |

## Open issues and next action
- The "Move to" menu lists 14 places plus 2 swaps with three panes; grouping them by layout could make it shorter.
- At 320 px the fourth tab is reached only by scrolling the tab row.
- With no tracker in e2e, seeded descriptions show "Could not load the data".
- Two Dashboard e2e tests sometimes fail when run repeatedly: "Two quick ticks in Customize" and FlowMap #14.
- **Next:** batch 4 (entry points), then batches 5–9.
