# Status: Markdown notes in folders, with a navigable tree

Planned (2026-10-29), not started.

## Goal and completion criteria
- Notes can be organized in **folders**, nested to any depth, and the **tree can be navigated**:
  - by mouse, keyboard and touch;
  - with drag and drop to move;
  - showing where a note lives (breadcrumb).
- Done when the four steps below are delivered and every check in "Checks" passes.

## What exists today (starting point)
- `markdown_notes` is already a tree: `parent_id` + `position` (index `idx_markdown_notes_active_tree`, same-user FK).
- `notes.tree` lists it and `notes.move({ id, parentId, index })` moves a note.
- `src/components/notes/NoteTree.tsx` + `treeModel.ts` draw it, with expand/collapse.
- What is missing:
  - a note is always a page: there is no "folder" that only groups;
  - there is no keyboard tree navigation (ARIA tree pattern);
  - there is no drag to move;
  - a note's place in the tree is not shown (no breadcrumb);
  - no folder view lists a folder's contents.

## Decisions to keep
- **One table, a kind.** `markdown_notes.kind` is `note` or `folder` (check constraint, default `note`).
  - A folder has a title and children; it has no body, no versions and no issue link.
  - The existing tree, move, trash and restore code then work for folders unchanged.
  - Migration `NNNN_note_folders.sql`, generated after the current last migration (`0016_planned_entries`). **Check the `when` order**: a migration older than the last applied one is skipped (`api/queries/migrationGuard.ts`).
- **Pages may still hold pages.** Folders add grouping; they do not take nesting away from notes.
- **Ordering.** Folders first, then notes, each by `position`, and dragging keeps that rule.
- **A folder lives at the root or in a folder, never in a note** (decided 2026-10-29). Folders hold notes and folders; notes hold only notes. A folder dropped on a note is refused, with the reason.
- **A click on a folder opens its folder view** (decided 2026-10-29), as in Finder or Explorer; only its chevron expands and collapses it in the tree.
- **Like a file manager** (2026-10-29):
  - "New folder" and "New note" in the tree's header, creating in the selected folder (or at the root).
  - On each row, a "…" menu, also on right-click: New folder here, New note here, Rename, Move to…, Delete.
  - Rename inline: F2 or the menu; Enter or leaving the field saves, Esc cancels; an empty title is refused.
  - A new folder is made at once as "New folder" ("New folder 2"…), with its name open for typing.
  - Delete or Backspace on a row asks first (the confirmation that warns about descendants).
- **Search finds folders by name** (decided 2026-10-29), shown with a folder icon and their path; a click opens the folder view.
- **Notes that already hold notes stay notes** (decided 2026-10-29). Their menu offers "Convert to folder" only while their text is empty (nothing would be lost), they link no issue, and they do not sit in a note.
- **Buttons** (decided 2026-10-29): the header's "New note" stays, and now creates in the selected folder. "New child note" goes: the row menu's "New note here" replaces it.
- **Trash.** Deleting a folder sends its subtree to the trash as one batch (`deleteBatch`, as today); restoring brings back the whole batch.

## Steps
- [x] **1. Data and API.** Done 2026-10-29: `kind` (migration `0017_note_folders`), `createFolder`, `rename` (over the revision shown), `convertToFolder`; folders kept first among siblings by `normalizeSiblings`; folders refuse text and issues; search returns `kind`. The child count is not sent: the page counts from the flat tree it already has.
  - `kind` column and migration.
  - `notes.createFolder({ title, parentId })` and `notes.rename`.
  - `notes.tree` returns `kind` and the count of children.
  - `move` refuses cycles (already) and a folder going under a note.
  - Tests: `api/routers/notes*.test.ts`; parity.
- [x] **2. Tree navigation (ARIA tree).** Done 2026-10-29: rows are `role="treeitem"` (a click or Enter opens; the issue key is a label, so no control sits outside a tree item); arrows, Home/End, type-ahead, F2, Delete/Backspace, Shift+F10 or the menu key; "…" and right-click share one menu; inline rename closes once (Enter, Esc or leaving); the open folder shows its contents until closed by hand.
  - `NoteTree` as `role="tree"` / `treeitem`, with `aria-expanded` and `aria-level`.
  - Keys: ↑↓ move, → opens or goes to the first child, ← closes or goes to the parent, Home/End, Enter opens, type-ahead.
  - The expanded state is remembered per device; the tree follows the open note (expand to it, scroll into view).
  - Folder and note icons.
  - A "New folder" action at the root and in each folder's menu.
- [ ] **3. Moving.**
  - Drag and drop in the tree: before, after, or into a folder, with a drop indicator and auto-expand on hover.
  - On touch, and as the keyboard alternative: a "Move to…" dialog with a searchable folder picker.
  - Undo in the toast.
- [ ] **4. Where am I.** Breadcrumb and folder view done 2026-10-29 (the page header's breadcrumb takes the folders as steps, `Breadcrumb` `trail`); search results' path still to show.
  - A breadcrumb (folder › folder › note) on the note page, each step opening that folder.
  - A folder view that lists its contents with "New note here" and "New folder here".
  - Search results show each note's path.
- [ ] Each step through the design system (`docs/design-system.md`):
  - `ActionRow` for tree rows; `surface()` on what stands out;
  - nothing wider than the sidebar at 320 px;
  - light and dark checked.

## Checks (to run)
| Command | Scope |
| ------- | ----- |
| `vitest run api/routers/notes*` | folders, move rules, trash of a subtree |
| `node --test e2e/notes.test.mjs` (extended) | create folder, keyboard tree navigation, drag and "Move to…", breadcrumb, phone |
| `pnpm lint && pnpm check` | design system and types |

## Blocks and next action
- The notes area was built by another agent. Check `git status` for notes work in progress before touching `src/components/notes/*` or `api/routers/notes.ts`.
- Next action: step 1.
