# Status: user batch 2026-10-30

## Goal and done criteria
Nine user requests, one batch each, in order 0 → 1 → 6 → 7 → 4 → 2 → 8 → 5 → 3:
notes tree layout, Kanbunny drawn twice, paused timer visible after "Later",
discard a timer from the log dialog, compact Estimates settings, branch/commit
copy, notes date + diary + AI summaries + AI tidy (Original | AI rotation), idea
links/images, repository paths + "Analyse" command. Each batch is done when its
unit/API tests and e2e pass and parity is up to date.

## Constraints and out of scope
- Dev :3000 only, test servers with `PROVIDERS_READ_ONLY=1`; never touch prod.
- Migrations: new files only (0024 note date + AI, 0025 idea files, 0026 container paths).
- Mods stay 1.0.0; no self-signed licences; no forced caches.
- Out of scope: Outlook calendar in the diary; Kanbunny's brain bound to the
  first slot's host API; other `grid` + `truncate` lists outside the notes aside.

## Decisions
- Analyse copies a shell command (single-quoted literals, no heredoc: issue text could close it).
- Paused timers are drawn as static hatched "to log" blocks, placed with `placeBlock`.
- Note date is its own text column (`noted_on`), backfilled in JS (Postgres runs in UTC).
- AI tidy keeps the original and the AI copy on the same note; "Keep AI" snapshots the original as an `ai` version.

## Batches
- [x] 0 Notes layout (nav `current: true`, `minmax(0,1fr)` tracks, lint rule, e2e at 1280/320 — failed before the fix: aside scrolled 553 px)
- [x] 1 Kanbunny (brain `tripping` + phases, goal trips first, edge gated with rewards held; rebuilt 1.0.0 and installed on dev, old build backed up in the session scratchpad)
- [x] 6 Later / pending timeline (`placePendingTimers` + hatched still blocks, phone rows, header "N to log", typed comment kept as timer note; mobile: Stop on a paused timer already reopens the log)
- [x] 7 Discard timer (`DiscardTimerDialog`, mounted only while asked; discard while running in TimerControls, QuickControls and the phone sheet; "Discard timer" in the timer's log dialog)
- [x] extra (user, mid-batch): a click on a folder row toggles it; side by side (lg) it also opens the folder's view, on a phone only the toggle; Enter opens the view
- [x] extra (user): a folder click acts on that folder only — the open note's branch is revealed once per selection instead of being forced open on every render (a parent couldn't close; closing one reopened the selected folder); e2e failed before
- [x] 4 Estimates compact (one group, per-category switch grid, reset only on changed, "Reset all", history in a disclosure; screenshots desktop/320 checked)
- [x] 2 Branch + commit (`branchName` with bugfix/ by type, no trailing lone letter/linking word, 60 chars at a word; `commitMessage`; menu + `m` key; `docs/git-jira.md` with a tested prepare-commit-msg hook)
- [x] 8 Notes date, search, diary, AI (migration 0024_note_date_ai + data step note-noted-on; `contracts/noteQuery.ts` date terms + chips; `/notes/diary` with notes, time, plans, pinned mails; report/timeline via Ollama saved as a note, Copy for model; Tidy up with AI as Original | AI with Keep/Discard/Redo/Compare, Undo via an `ai` version, paste-back without a local model). Not done: client filter for the summary (server takes folderId, no UI yet)
- [x] 5 Ideas links/images (migration 0025_idea_files, sealed bytes, type from magic bytes, 5 MB / 20 per idea / 100 MB per user, owner-only GET (404 otherwise), signed `idea-file` share links for handoff (revoked with the others), `RichText.resolveImage`, `IdeaBody` with Write/Preview, Add image (phone picker), paste/drop, link; card shows the picture count; promote fetches pictures, names them idea-<id>.<ext> in the text and attaches them after creation). Deviation: no shared `MarkdownField` extracted (IdeaBody is a lighter editor)
- [x] 3 Repository paths + Analyse (migration 0026_container_paths + settings.agent_command; Settings → Repositories, desktop only; `contracts/analyze.ts` single-quoted words, no heredoc, tested through sh/bash with hostile text; `issues.analyzeCommand`; menu item on desktop when the project has paths)

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| `node --test e2e/notes.test.mjs` | batch 0 | 9 pass |
| `pnpm lint`, `pnpm check` | batch 0 | ok |
| modules `pnpm test`, `pnpm typecheck` | batch 1 | 304 pass, ok |
| `node --test e2e/mods-real.test.mjs` | batch 1 | 5 pass |
| `pnpm test` | batch 6 | 2485 pass |
| e2e dashboard-day, timer-note, day-review, timer-lock, regressions | batch 6 | 88 pass (new ones failed before the fix) |
| e2e timer-discard (new, failed before), regressions, layout-overflow, a11y, renders, surfaces, estimates | batch 7 | pass; renders first over budget (5858 > 5509) with the confirm dialog always mounted, 5210 after mounting it on demand |
| `vitest src/lib/issues.test.ts`, e2e issue-copy, keyboard-list | batch 2 | pass |
| `pnpm test` | batch 8 | 2506 pass |
| e2e notes, notes-diary, ssr, mail-pins | batch 8 | 25 pass |
| `pnpm test` | batch 5 | 2509 pass (migrations rollback test updated for idea_files) |
| e2e ideas | batch 5 | new picture test passes; "an idea becomes a Jira issue through the usual dialog" fails on clean HEAD too (pre-existing, its fake of issues.create no longer matches the dialog) |
| `pnpm test` | batch 3 | 2517 pass |
| e2e issue-copy (Analyse) | batch 3 | pass |
| `pnpm build && pnpm test:smoke && PROVIDERS_READ_ONLY=1 node --test 'e2e/*.test.mjs'` | final | 282/284: "an idea becomes a Jira issue" (pre-existing, fails on clean HEAD), "the pane sends the copy where Outlook can" (flaky under concurrency: passes alone, area untouched) |
| e2e notes | folder toggle | 11 pass ("folders like a file manager" now opens the view with Enter) |

## Blocks and next action
Done (not committed). Open: summary filter by folder/client UI; Outlook calendar in the diary; the pre-existing promote e2e. Note: no e2e for "one bunny during a trip" (brain unit tests cover it).
