# State: Desk (issues side by side) — partial

## Goal and done criteria
`/issues/desk` shows up to 6 issues at once, tiled like snapped windows: halves, thirds, rows, one big pane with the others beside it, quarters, two rows of different counts, or grids of six.

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
- **Empty slots:** a slot of the arrangement may hold `{ empty: true, id }` (id "1"–"99", the first free one, so the model stays pure and deterministic). They count towards the six, are stored, and survive `normalizeDesk`, which dedupes issues and drops a desk of empty slots alone. `addPane` (and the server's `desks.add`) fills the first one; `setPreset` adds or drops them; they are never parked. Phones show the issues alone.
- **Sending from an issue page** (`placeIssue`): this issue in the chosen slot, the desk's other issues in the other slots in their order while they fit (the rest parked), empty slots for what is left. The page offers `pagePresets(n)`, at most six arrangements with room for the desk's issues plus this one (n at least 2: an issue sent alone keeps an empty slot beside it). Alt+Shift+arrows use the halves, so the desk's first other issue takes the other half.
- **Shift-click** (`useOpenBeside`, capture phase in the shell; Shift alone): on the Desk it fills the first empty slot (an event the Desk page handles); on an issue page the Desk opens with the two side by side (`sideBySide`, others parked); elsewhere `desks.add` (which now also takes `{ connectionId, remoteId }`) and a toast "n/6" with "Open desk". The work lives in `src/lib/desk/send.ts`, loaded on first use.
- **Dragging issues in:** rows (their key link; pinned rows as a whole) and board cards add `application/x-inkledger-issue` beside their own types (`setIssueDragData`). The Desk takes it on an empty slot, on its snap places with one more slot (a full desk: the pane under the pointer is parked), and on the sidebar's Desk entry.
- **Picking in Issues:** `x` and checkboxes (shown on hover, all once one is picked; a card's menu has "Pick for the desk"), then the bar's "Open on desk" (`openTogether`, the default arrangement for the count; disabled above six, saying why).
- **Six panes (4b):** `DESK_MAX_PANES` is 6 (empty slots count). New arrangements: `rows-3`, `rows-4`, `main-{left,right,top,bottom}-3`, `main-left-4`/`main-right-4` (big beside a 2×2), `top-3-bottom-2`/`top-2-bottom-3` (on six columns, each pane spanning two or three), `grid-3x2`, `grid-2x3`; defaults 5 → `main-left-4`, 6 → `grid-3x2`. Old ids stay; a stored desk with an id this version doesn't know keeps its issues in the default (the schema reads `preset` as any string). Spanning panes: `minTrackOf` lets a column go to MIN_TRACK/2 where every pane covers two or more, so no pane is ever under MIN_TRACK; dividers and `normalizeDesk` use it. `fitPreset` measures each pane at even sizes (20×14 rem minimum) and falls back along `FALLBACKS`; when nothing fits, the candidate whose tightest pane comes nearest. Edges with 4–5 panes make the pane the big one on that side, corners a small one opposite (4: quarters); with 6, corners are the grid's corners and edges the middle of a side. The Layout picker groups arrangements by pane count (two columns); "Move to" lists places flat up to 8, beyond that one submenu per arrangement. Keys `1`–`6`; toasts "n/6".
- **Ask AI (4c):** a chat with the local model (Ollama at OLLAMA_URL only, the same refusal rules as the other AI features) about the issues shown, never the parked ones.
  - *Context:* built on the server (`api/desk/chat.ts`) from each issue's agent copy (`agentCopy`), header alone when the tracker can't give the description; any issue that isn't the user's refuses the whole question (404). The page sends the desk's slots with every question, so the context follows the desk; the panel shows the issues as chips and says when the desk changed under the conversation.
  - *Transport:* `POST /api/desk/chat` answers as server-sent events (`context`, `delta`, `draft` a few times a second with the answer so far as a document, `done`, `error`, or a single `off`); 12 questions a minute per user; the client gone, the request to Ollama is aborted. `streamChat` / `readOllamaStream` in `api/ai/ollama.ts`; the simulator streams a fixed answer word by word.
  - *Conversation:* in the browser only (`src/lib/desk/chat.ts`), kept while the panel is closed and across pages until a reload; "New chat", or a desk whose issues all changed, clears it. Markdown is drawn by `RichText` from the server's parse, never as HTML.
  - *Panel:* docked beside the desk on wide screens (an in-page column, not a modal sheet, so the desk stays usable and refits), a full sheet on phones; lazy. `a` opens it.
  - *Save as note:* one note with every key in its body, linked to the focused pane's issue (or the first): linking it to every issue waits for batch 7 (`markdown_note_issues`).
- **The chat reads the code (4d): a Pi-style native harness.** Asked whether issues are "really solved looking at the codebase", the chat used to say it had no access to the code. Now the model explores the user's repositories by itself, over several steps, with a small read-only tool set; the **server never reads repositories**, the user's machine does.
  - *Pi considered and rejected:* Pi (pi.dev) would have given a ready harness, but it needs Node 22 and would add a 60–100 MB sidecar to the app. We keep our own harness in Pi's style instead: no sidecar, no new runtime, the app stays lean.
  - *Tools* (`contracts/codeTools.ts`, Pi's read/grep/find/ls plus git): `ls`, `find` (a glob over paths), `grep` (text or regex, line numbers, at most 40 hits), `read` (at most 400 lines a call), `git_log` (by message or path, with the files changed), `git_show` (a patch, truncated). Never bash, write or edit. `repo` is a repository's label or number; paths are relative to it, and absolute paths, drive letters, `~`, `..`, `:` and links out of it are refused. Walks skip `.git`, `node_modules` and build output, binaries and files over 1 MB. Private files (version control, `.env` files but their examples, keys, credentials) are never listed, searched or read (`isPrivateName` / `is_private`); a whole disk or the home folder can't be allowed as a repository. A result the model reads is capped at 12 KB.
  - *One loop* (`src/lib/desk/agent.ts`): a small state machine shared by the browser and the app, tested on its own; only the executors differ (`src/lib/desk/code.ts`: the app's Rust commands or a connected folder). The page posts, the server streams text or ends with a `tool_calls` event, the page runs each call, appends `assistant` (with `tool_calls`) and `tool` messages and posts again. At most 12 rounds a question; then no tools are offered and the server tells the model to answer now (it refuses a 13th round). A tool has 30 s; Stop aborts between and during steps.
  - *Context compaction* (`compactWire`): when the current question's rounds pass 40 000 characters, the oldest tool results become their one line ("read src/x.kt lines 1–200 (elided)"); the last three stay whole. Earlier questions are sent as question and answer only, never their tool rounds.
  - *Steady prompt* (`api/ai/prompts/deskChat.ts`): short; it lists the tools with one line each and the repositories by label (labels are context, never part of the tool schemas, and never paths). It names the issue keys and requires them quoted exactly: the "APP-400" for MAGA-400 came from the old prompt's example key "APP-12", not from the context, which carried the right key. It says to check the code before claiming something solved (commits mentioning the key, then the changed code), and to answer in the user's language.
  - *Route* (`POST /api/desk/chat`): stateless; with no tools offered it behaves as before. New optional fields `tools`, `repos` (labels), `extracts`; messages may be `assistant` with `tool_calls` and `tool`; all validated with zod (known tools only, each call answered by exactly one result right after it, arguments ≤ 2 KB, results ≤ 12 KB, 160 000 characters in all, 12 rounds). A tool round reuses its question's issue context for 2 minutes (the trackers are asked once a question). Rate limits: 12 questions a minute, and tool rounds counted apart (144 a minute). A unit test spies on `fs` during a tool round and checks the route's modules import no file system or process API.
  - *Reach* (`POST /api/desk/chat/reach`): the projects of the issues shown with their repository paths (Settings → Repositories), the issues' titles, and whether the model is on and can call tools.
  - *Model:* `OLLAMA_CHAT_MODEL` (falls back to `OLLAMA_MODEL`). Tool support is read from Ollama's `/api/show` (`capabilities` includes `tools`), cached 10 minutes (30 s when Ollama didn't answer). Without it the page builds *extracts*: it greps the repositories in reach for each key and two distinctive title words (and, in the app, `git_log` by key) and sends the hits with the question (at most 16 KB). The panel says the mode in plain words.
  - *In the app (macOS, Windows):* Rust commands in `src-tauri/src/code.rs` (docs/native.md), registered in `build.rs` and `capabilities/remote.json` (the native-shell e2e checks both now). Each root is allowed once in a native dialog, kept per server in `code-access.json`; the commands refuse roots that aren't allowed. Git through the `git` program, fixed arguments, hex commit ids; no git, no git tools.
  - *In a browser (Chromium):* "Connect folder" per project (`showDirectoryPicker`, read mode); the handle is kept in IndexedDB (every access in try/catch; a handle that can't be stored lasts until a reload) and permission is asked again when needed. `ls`, `find`, `grep`, `read` in TS (`browserCode.ts`), on the main thread with a turn given back every 100 files: a worker can't receive a stubbed handle, and the walk is capped (20 000 files).
  - *Elsewhere* (Safari, phones): the chat works as before and says in one line that code is not in reach and how to bring it in.
  - *Panel:* a "Code" row under the issues: the repositories in reach as chips, "Allow <repo>" (app) or "Connect folder" (browser) where needed, then the mode line. Each tool step is a compact line above its answer ("Searching “inventario” in app: 3 hits", "Reading src/…/InventoryService.kt", "Commits mentioning MAGA-400"), which opens to show what the model read.

## Batches and progress
- [x] 0. Layout model (`contracts/desk.ts`, tests)
- [x] 1. `IssueBody` as page or pane; the issue page is unchanged (byte-identical screenshots)
- [x] 2. Desk page: current desk, layouts, dividers, parking tray, maximize, phone tabs, `g e` / `1`–`4` (now `1`–`6`) / `x`
- [x] 3. Snapping by drag, keys or menu ("Move to", "Swap with"); live region announcements
- [x] 4. Entry points and the Desk in the workflow: empty slots, sending an issue from its page (grip to an edge, Layout button, Alt+Shift+arrows, long press on a phone), Shift-click on issue links, "Open beside", dragging from lists and the board, picking in Issues
- [x] 4b. Up to six panes and more arrangements (presets, fit, snap edges, picker, Move to, keys, toasts, tabs)
- [x] 4c. Ask AI: a chat with the local model about the issues shown (`api/desk/chat.ts`, `DeskChat`)
- [x] 4d. The chat reads the code on the user's machine: tools, agent loop, Rust commands, browser folders, extracts fallback
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
| `PROVIDERS_READ_ONLY=1 pnpm test:smoke` | first load | 859.2/273.3 KiB (batch 2); 867.2/275.9 KiB (batch 4) |
| `pnpm lint && pnpm check && OLLAMA_URL= pnpm test && pnpm build && pnpm db:check` | batch 4 | pass; 2891 unit tests |
| `e2e/desk-flow.test.mjs` (new) + `desk` + `desk-snap` | batch 4 | 15/15, ×3 |
| a11y, board, issue-*, keyboard-list, layout-overflow, manage-issue, create-issue, regressions, desk* | batch 4 | 123/123 |
| `pnpm lint && pnpm check && OLLAMA_URL= pnpm test && pnpm build && pnpm test:smoke && pnpm db:check` | batch 4b | pass; 2909 unit tests; first load 868.0/276.1 KiB |
| `desk` + `desk-snap` + `desk-flow` + `desk-six` (new) | batch 4b | 19/19, ×3 |
| issue-copy, issue-hotkeys, issue-links, manage-issue, create-issue, keyboard-list, layout-overflow, a11y | batch 4b | 25/25 |
| `pnpm lint && pnpm check && OLLAMA_URL= pnpm test && pnpm build && PROVIDERS_READ_ONLY=1 pnpm test:smoke && pnpm db:check` | batch 4c | pass; 2905 unit tests; first load 868.9/276.5 KiB |
| `e2e/desk-chat.test.mjs` (new) | batch 4c | 4/4, ×3 |
| `desk`, `desk-snap`, `desk-flow` | batch 4c | 15/15 |
| `pnpm lint && pnpm check && OLLAMA_URL= pnpm test && pnpm build && PROVIDERS_READ_ONLY=1 pnpm test:smoke && pnpm db:check` | batch 4d | pass; 2969 unit tests; first load 873.6/278.0 KiB |
| `cargo test` in `src-tauri` (offline) | batch 4d | 28/28 (8 new in `code.rs`) |
| `e2e/desk*.test.mjs` (4 new chat tests) | batch 4d | 27/27 in 3 of 4 runs; one run had the snap test "with three, the left edge…" fail (passes alone, 5/5) |
| native shell config (`regressions`, now also `build.rs`) | batch 4d | 1/1 |

## Open issues and next action
- At 320 px three of six tabs show; the others are reached by scrolling the tab row (or the arrows).
- A divider of a spanning arrangement (three above two) moves one six-column line: its value is that column's share, not the pane's; and a pane there can shrink only to its other column plus half the minimum.
- With five panes the top and bottom edges are not symmetric (top: the wide top-left of "two above three"; bottom: the wide bottom-left of "three above two").
- With no tracker in e2e, seeded descriptions show "Could not load the data".
- Two Dashboard e2e tests sometimes fail when run repeatedly: "Two quick ticks in Customize" and FlowMap #14.
- The title's grip is for the pointer only (keyboard: the Layout button and Alt+Shift+arrows), and only on wide screens.
- On a phone the title can't be selected (a long press opens the Desk's places).
- The palette's "Desk" group (saved desks) waits for batch 9.
- An issue dragged from the board or a list can reach the Desk only through the sidebar entry (another page); dropping on the Desk itself needs the Desk beside the list (a second window).
- The chat's answers were tried with the simulator only, never with a real model in this batch: the prompt's behaviour (citing keys, staying on topic, the language) is unverified on a real Ollama.
- While an answer is written, what came after the last `draft` (up to 150 ms) shows a moment later; a stopped answer keeps the last draft's drawing.
- 4d was tried with the simulator, a stubbed native bridge and an in-memory folder only: no real Ollama (tool calling, the prompt's effect on "APP-400"), no real app window (the NSAlert and Windows dialogs), no real `showDirectoryPicker`. The Windows build was not checked: `cargo check --target x86_64-pc-windows-gnu` stops at `ring`'s C code (no mingw here), before our code.
- Ollama's tool-call streaming varies by version and model (calls may come in one line or several); the reader accepts calls on any line, arguments as an object or JSON text.
- The browser can't tell whether a connected folder holds links that lead out; it only exposes what is inside the picked folder.
- **Next:** batches 5–9.
