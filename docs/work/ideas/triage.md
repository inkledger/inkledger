# Spec: a waiting room that turns ideas into issues (#6)

Status: batches 1–4 done (2026-10-30); batch 5 waits for Q3 (the model and where Ollama runs) and for infra batch 3. Open questions are asked when their batch is reached (README, R-0.12).


## Problem
- Ideas that are not yet TODOs, notes or issues need a place where they get refined into actionable issues.
- Vague issues should be able to land there too.
- Each idea then gets a route: ask by mail, hand to an agent, or do it myself.
- A local model can help with the refining.

## Requirements
- **R-2.1** An idea MUST have one of the states `raw | refining | ready | promoted | discarded`, with transitions allowed only by `canMove` (table below).
- **R-2.2** Capture: a block of text MUST become one idea per non-empty line.
  - Leading list markers MUST be stripped: `^\s*(\d+[.)]|[-*•]|\[[ x]\])\s+`.
  - Lines MUST be trimmed and truncated to 200 characters. Text that gets cut MUST go into the body.
  - More than 50 lines → E-2.2.
- **R-2.3** `ready` requires all three:
  - a title of at least 3 characters;
  - at least 1 acceptance criterion;
  - no unanswered question with `blocking: true`.
- **R-2.4** A tracker issue MUST be able to become an idea without anything being written to the tracker. An issue can have at most one open idea, that is, one not in `promoted` or `discarded` and not deleted.
- **R-2.5** Promoting MUST go through the existing dialog: `openCreateIssue({summary, description, onCreated})` (`src/lib/createIssue.ts`) → `issues.createIn` (`api/routers/issues.ts:779`). Then `ideas.linkPromoted`.
  - The description MUST be the body plus the "Acceptance criteria" (as a list) plus the answered questions.
- **R-2.6** Routes:
  - `me`: promote, then offer "Make a TODO" through `todos.add({text, issueKey, connectionId})`.
  - `agent`: produce a handoff markdown, with exactly the format in "Handoff format" below.
  - `ask`: produce a `mailto:` holding the unanswered questions.
- **R-2.7** Delete is soft (`deleted_at`), with Undo through `restore`. Purged after 30 days, in `purgeTrash` style.
- **R-2.8** The local LLM MUST only suggest. Nothing is saved without a "Use" per field.
  - It MUST be absent from the UI when `OLLAMA_URL` is not set.
  - `OLLAMA_URL` MUST resolve to a loopback or private (RFC 1918 / ULA) address, unless `OLLAMA_ALLOW_PUBLIC=1`. Otherwise the server logs a warning at boot and the feature stays off.
- **R-2.9** Ideas are per user. A project (`container_id`) MUST be a container of one of the user's connections that is not archived; otherwise E-2.4.
- **R-2.10** The issue page MUST show the chip "In triage" when an open idea exists, and offer "Send to triage" when none does.
- **R-2.11** ⌘K MUST offer "New idea" (a capture dialog) and "Go to Ideas".

## Transitions (`contracts/ideas.ts` `canMove`)

| from \ to | raw | refining | ready | promoted | discarded |
|---|---|---|---|---|---|
| raw | — | ✓ | R-2.3 | ✗ (only through `linkPromoted`) | ✓ |
| refining | ✓ | — | R-2.3 | ✗ | ✓ |
| ready | ✓ | ✓ | — | ✗ | ✓ |
| promoted | ✗ | ✓ ("Reopen": the promoted link stays, as history) | ✗ | — | ✗ |
| discarded | ✗ | ✓ (Reopen) | ✗ | ✗ | — |

```ts
export const IDEA_STATES = ["raw", "refining", "ready", "promoted", "discarded"] as const;
export type IdeaState = (typeof IDEA_STATES)[number];
export type MoveRefusal = "notReady.title" | "notReady.acceptance" | "notReady.questions" | "promoteThroughIssue" | "terminal";
export function canMove(idea: Pick<Idea, "state" | "title" | "acceptance" | "questions">, to: IdeaState): { ok: true } | { ok: false; reason: MoveRefusal };
export function splitIdeas(text: string): { title: string; body: string }[];
export function handoffPrompt(idea: IdeaView, issue: { key: string; url: string } | null): { markdown: string; filename: string };
export function askMailUrl(idea: IdeaView, to: string | null): string; // ≤ 2000 chars, questions cut with "…"
```

## Handoff format (exact, an English template; the idea's content stays in the user's language)
```md
# <title>
Issue: <KEY> <url>            ← only if promoted
Project: <container name>     ← if any

## Problem
<body>

## Acceptance criteria
- [ ] <criterion>

## Decisions already taken
- <question> → <answer>

## Open questions (ask before deciding)
- <question>

## Constraints
Follow the repository's CLAUDE.md and its checks. Do not push.
```
- Filename: `idea-<id>-<slug(title, 40)>.md`.

## Out of scope
- Sending mail: there is no SMTP, and Graph has `Mail.Read` only.
- Sharing ideas with other users.
- Writing to the tracker anything other than the issue creation the user confirms in the dialog.

## Decisions
- **D-2.1** A new `ideas` table, not a kind of TODO.
  - *Why:* the lifecycle (states, readiness, routes) has nothing to do with the day-based planning of `todos` (`db/schema.ts:1051`).
- **D-2.2** Promotion goes through the existing CreateIssue dialog, not a new procedure.
  - *Why:* reuse. Target, type and read-only handling are already solved. The post-it works this way (`Pinboard.tsx:335-343`).
  - Only Jira and GitHub support `manage.create`. For other trackers, `createTargets` doesn't list them, and the idea offers "Copy as text".
- **D-2.3** The kanban is **not** the Board.
  - *Why:* `Board.tsx` is tied to tracker transitions (`startDrag` :332, `onDrop` :358).
  - The kanban copies its DOM pattern only: draggable, dataTransfer type `application/x-idea`, and the `renderColumn` layout.
- **D-2.4** The LLM is Ollama, called on `/api/chat` with `format: <JSON schema>`, `stream:false`, `temperature 0.2`.
  - The output is validated with zod. If it is invalid → E-2.6, with no automatic retry.
  - `OLLAMA_URL` may point at a LAN machine (DGX Spark, Jetson…).

## Data model (`NNNN_ideas.sql`)
```ts
export const ideas = pgTable(
  "ideas",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Markdown */
    body: text("body").notNull().default(""),
    /** contracts/ideas.ts IDEA_STATES */
    state: text("state").notNull().default("raw"),
    /** me | agent | ask (null: not chosen) */
    route: text("route"),
    containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
    /** Order within its state (smaller first) */
    position: integer("position").notNull().default(0),
    /** JSON [{ id, text }] (≤ 20) */
    acceptance: text("acceptance").notNull().default("[]"),
    /** JSON [{ id, text, answer, blocking }] (≤ 20) */
    questions: text("questions").notNull().default("[]"),
    /** JSON string[] (≤ 20) */
    labels: text("labels").notNull().default("[]"),
    estimateSeconds: integer("estimate_seconds"),
    /** The issue it came from (a vague one sent to triage) */
    sourceConnectionId: integer("source_connection_id").references(() => connections.id),
    sourceItemId: integer("source_item_id").references(() => issues.id, { onDelete: "set null" }),
    sourceIssueKey: text("source_issue_key"),
    /** The mail it came from */
    mailId: integer("mail_id").references(() => mails.id, { onDelete: "set null" }),
    /** The issue it became */
    promotedConnectionId: integer("promoted_connection_id").references(() => connections.id),
    promotedItemId: integer("promoted_item_id").references(() => issues.id, { onDelete: "set null" }),
    promotedIssueKey: text("promoted_issue_key"),
    promotedAt: ms("promoted_at"),
    discardedReason: text("discarded_reason"),
    deletedAt: ms("deleted_at"),
    createdAt: ms("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: ms("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_ideas_user_state").on(t.userId, t.state, t.position),
    uniqueIndex("uq_ideas_open_source")
      .on(t.userId, t.sourceConnectionId, t.sourceIssueKey)
      .where(sql`${t.sourceIssueKey} IS NOT NULL AND ${t.state} NOT IN ('promoted','discarded') AND ${t.deletedAt} IS NULL`),
    check("ideas_state", sql`${t.state} IN ('raw','refining','ready','promoted','discarded')`),
    check("ideas_route", sql`${t.route} IS NULL OR ${t.route} IN ('me','agent','ask')`),
    check("ideas_source_has_connection", sql`${t.sourceIssueKey} IS NULL OR ${t.sourceConnectionId} IS NOT NULL`),
    check("ideas_promoted_has_connection", sql`${t.promotedIssueKey} IS NULL OR ${t.promotedConnectionId} IS NOT NULL`),
  ],
);
```
- `sourceItemId` and `promotedItemId` are filled from the key the same way `itemRef` is: check whether the trigger pattern `mail_links_link_item` (`drizzle/0013_mail_pins.sql`) has to be repeated, so the link follows key changes.

## API (`api/routers/ideas.ts`, `ideas: ideasRouter` in `api/router.ts`)
```ts
const id = z.number().int().positive();
const title = z.string().trim().min(1, { error: () => t("server.ideas.empty") }).max(200);
const body = z.string().max(20_000);
const state = z.enum(IDEA_STATES);
const route = z.enum(["me", "agent", "ask"]);
const acceptance = z.array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(500) })).max(20);
const questions = z.array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(500),
  answer: z.string().trim().max(2000), blocking: z.boolean() })).max(20);
const labels = z.array(z.string().trim().min(1).max(60)).max(20);
const estimate = z.number().int().min(60).max(30 * 24 * 3600);

list:      .input(z.object({ containerId: z.union([id, z.literal("none")]).optional(), states: z.array(state).max(5).optional() })) // → IdeaRow[] by state, position, id
counts:    .query()                                                   // → Record<IdeaState, number>
get:       .input(z.object({ id }))                                   // → IdeaRow
capture:   .input(z.object({ text: z.string().max(20_000), containerId: id.optional() }))   // → IdeaRow[] (raw, at the top)
update:    .input(z.object({ id, title: title.optional(), body: body.optional(), route: route.nullable().optional(),
             containerId: id.nullable().optional(), acceptance: acceptance.optional(), questions: questions.optional(),
             labels: labels.optional(), estimateSeconds: estimate.nullable().optional() }))  // → IdeaRow
move:      .input(z.object({ id, state, index: z.number().int().min(0).max(5000), reason: z.string().trim().max(500).optional() }))
reorder:   .input(z.object({ state, ids: z.array(id).max(2000) }))
remove:    .input(z.object({ id }))    restore: .input(z.object({ id }))
fromIssue: .input(z.object({ issueKey: issueKeyInput, connectionId: id.optional() }))   // → IdeaRow (the open one if there is one)
forIssue:  .input(z.object({ issueKey: issueKeyInput, connectionId: id.optional() }))   // → { id, state } | null
linkPromoted: .input(z.object({ id, issueKey: issueKeyInput, connectionId: id }))       // → IdeaRow (state promoted)
handoff:   .input(z.object({ id }))                                   // → { markdown, filename }
askMail:   .input(z.object({ id, to: z.string().trim().email().max(320).nullable() })) // → { url }
llm:       .query()                                                   // → { available: boolean, model: string | null }
suggest:   .input(z.object({ id }))                                   // → IdeaSuggestion
```
`IdeaRow` = the columns plus:
- `container: {id, key, name} | null`;
- `source: {key, connectionId, summary} | null`;
- `promoted: {key, connectionId, summary, url} | null`;
- `acceptance`, `questions`, `labels` already parsed.

```ts
export const ideaSuggestionSchema = z.object({
  title: z.string().max(200).optional(), problem: z.string().max(4000).optional(),
  acceptance: z.array(z.string().max(500)).max(10).optional(), outOfScope: z.array(z.string().max(500)).max(10).optional(),
  questions: z.array(z.string().max(500)).max(10).optional(), split: z.array(z.string().max(200)).max(8).optional(),
  labels: z.array(z.string().max(60)).max(8).optional(), estimateMinutes: z.number().int().min(5).max(43200).optional(),
});
```
- The same JSON schema is passed to Ollama as `format`.
- The prompt is in `api/ai/prompts/idea.ts`: English, with "answer in <language of settings>".
- Client `api/ai/ollama.ts`: `chat<T>(schema, messages, {timeoutMs: 90_000})`, `keep_alive:"5m"`.
- Env: `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_ALLOW_PUBLIC`, `OLLAMA_SIMULATOR` (a fixed response that passes the schema).

**Errors**

| E | Code | Key | When |
|---|---|---|---|
| E-2.1 | NOT_FOUND | `server.ideas.notFound` | not mine or deleted |
| E-2.2 | BAD_REQUEST | `server.ideas.tooMany` | capture over 50 |
| E-2.3 | BAD_REQUEST | `server.ideas.move.<MoveRefusal>` | `canMove` refuses |
| E-2.4 | NOT_FOUND | `server.ideas.noContainer` | the container is not the user's |
| E-2.5 | PRECONDITION_FAILED | `server.ideas.llmOff` | `suggest` without `OLLAMA_URL` |
| E-2.6 | BAD_GATEWAY | `server.ideas.llmBad` | output invalid against the schema |
| E-2.7 | TIMEOUT | `server.ideas.llmSlow` | > 90 s |
| E-2.8 | BAD_REQUEST | `server.ideas.empty` | capture with no valid line |

## UI
- **Route:** `/ideas` (`src/pages/IdeasPage.tsx`), registered in `src/App.tsx` in all three places (`load`, `FIRST`, `<Route>`).
- **Nav** (`src/lib/nav.ts`): group `main` after TODO, icon `Lightbulb`, label `ui.nav.ideas`. On a phone it shows under More by itself (`MobileMoreSheet.tsx:45`).
- **Page:**
```
PageHeader  title=pages.ideas.title  actions=[Select project (All · No project · containers), SegmentedControl Columns|List]
PanelSection Capture: Textarea (placeholder pages.ideas.capturePlaceholder) + Button "Add" (⌘↵); preview "N ideas" when >1 line
PanelSection Board (Columns): 3 columns Raw/Refining/Ready + collapsed Promoted, Discarded (useCollapsedColumns("ideas"))
   Card = ActionRow: title (line-clamp-2, [overflow-wrap:anywhere]) · chips: project, route, EstimateChip, "N open questions", source KEY · "…" menu
PanelSection List: same rows grouped by state (default under md, choice in localStorage ikl-ideas-view)
Sheet IdeaDetail (side; full screen < md): title Input · body (Markdown editor of the notes if it can be extracted from NoteEditor, otherwise Textarea + RichText preview)
   · Acceptance (list + add) · Questions (text, Blocking switch, answer) · Project Select · Route SegmentedControl · EstimateChip
   · Actions: [Suggest] (only llm.available) [Create issue] [Copy prompt][Download .md] [Write mail] [Discard] [Delete]
   · Suggestion panel: each field current | suggested + "Use"; "Use all"; useDirtyClose
```
- **Drag:**
  - Native, with type `application/x-idea`.
  - A drop refused by `canMove` → `toastError` with the reason; the card goes back.
  - Keyboard: "…" menu → "Move to" + `Alt+←/→`; `aria-live` announces the new column.
- **States:**
  - `PageSpinner` per region;
  - `EmptyState` (`pages.ideas.empty`: "Write your first idea, or paste a list: one per line");
  - `ErrorState` with Retry;
  - buttons busy while their mutation runs.
- **Issue page** (`IssueDetail.tsx`): "Send to triage" button in the actions, or a `Chip` "In triage" that opens `/ideas?open=<id>`.
- **⌘K** (`CommandPalette.tsx` ~:271): `ui.palette.newIdea` → flag `ideaCapture` (`src/lib/flag.ts`) → a small `IdeaCaptureDialog`. Navigation: `go("/ideas")`.

**i18n** (main keys, en / it):

| Key | en | it |
|---|---|---|
| `ui.nav.ideas` | Ideas | Idee |
| `pages.ideas.title` | Ideas | Idee |
| `pages.ideas.capturePlaceholder` | One idea per line. Paste a list too. | Un'idea per riga. Puoi anche incollare un elenco. |
| `pages.ideas.preview` | {count} ideas | {count} idee |
| `pages.ideas.state.raw/refining/ready/promoted/discarded` | Raw / Refining / Ready / Became an issue / Discarded | Grezze / Da raffinare / Pronte / Diventate issue / Scartate |
| `pages.ideas.acceptance` | Done when… | Fatta quando… |
| `pages.ideas.questions` | Questions | Domande |
| `pages.ideas.blocking` | Must be answered first | Va risolta prima |
| `pages.ideas.route.me/agent/ask` | I'll do it / An agent / Ask by mail | La faccio io / Un agente / Chiedo via mail |
| `pages.ideas.suggest` | Suggest | Suggerisci |
| `pages.ideas.use` / `useAll` | Use / Use all | Usa / Usa tutto |
| `pages.ideas.createIssue` | Create issue | Crea issue |
| `pages.ideas.copyPrompt` / `downloadPrompt` | Copy prompt / Download .md | Copia prompt / Scarica .md |
| `pages.ideas.writeMail` | Write mail | Scrivi mail |
| `pages.ideas.empty` | Write your first idea, or paste a list: one per line. | Scrivi la prima idea, o incolla un elenco: una per riga. |
| `ui.ideas.sendToTriage` / `inTriage` | Send to triage / In triage | Manda in smistamento / In smistamento |
| `ui.palette.newIdea` | New idea | Nuova idea |
| `server.ideas.*` | (one per E) | |

## Privacy
- Ideas leave the server only toward the `OLLAMA_URL` the admin configured (R-2.8).
- Handoff and mail are generated on the page, never sent.

## Performance
- `list` p95 < 30 ms with 1000 ideas.
- `/ideas` MUST NOT subscribe to timers. It does not enter `MEASURED` in the renders test, and the existing pages' budgets MUST NOT change.

## AC → test

| AC | Given / When / Then | Test |
|---|---|---|
| AC-2.1 | the notepad text (the 7 points, fixture `contracts/__fixtures__/notepad.txt`) · `splitIdeas` · 7 titles, without "1)"…"7)" | `contracts/ideas.test.ts` "a pasted numbered list becomes one idea per point" |
| AC-2.2 | a 250-char line · title 200, the rest in body | same file, "a long line keeps its rest in the body" |
| AC-2.3 | every pair in the transitions table | same file, "moves follow the table" (table-driven) |
| AC-2.4 | `handoffPrompt` with and without issue | same file, "the agent prompt has the agreed shape" (inline snapshot) |
| AC-2.5 | 30 questions of 200 chars · `askMailUrl` ≤ 2000 and ends "…" | same file, "the mail link stays under 2000 characters" |
| AC-2.6 | 51 lines · capture · E-2.2 | `api/routers/ideas.test.ts` "a capture over fifty lines is refused" |
| AC-2.7 | user B · get/update/move/remove/handoff of A's idea · NOT_FOUND | same file, "another user's ideas are not found" |
| AC-2.8 | another user's container · capture/update · E-2.4 | same file, "a project must be one of mine" |
| AC-2.9 | refining without criteria · move ready · E-2.3 notReady.acceptance; with a criterion and a blocking question unanswered · notReady.questions; answered · ok | same file, "ready needs criteria and answers" |
| AC-2.10 | fromIssue ×2 on the same issue · same id; after discarded · a new one | same file, "an issue has at most one open idea" |
| AC-2.11 | linkPromoted with an issue that is not mine · NOT_FOUND; mine · state promoted, `promoted` filled | same file, "an idea becomes the issue it was promoted to" |
| AC-2.12 | remove · not in list; restore · back; 31 days · purge | same file, "deleted ideas come back with undo and go after thirty days" |
| AC-2.13 | no OLLAMA_URL · llm.available false, suggest E-2.5; simulator · valid suggestion; simulator answering garbage · E-2.6 | `api/routers/ideas-llm.test.ts` "suggestions only from a configured local model" |
| AC-2.14 | OLLAMA_URL=https://api.example.com without ALLOW_PUBLIC · available false | same file, "a public model address is refused" |
| AC-2.15 | paste of 7 lines in the UI · 7 cards in Raw | `e2e/ideas.test.mjs` "a pasted list becomes seven ideas" |
| AC-2.16 | drag Raw→Refining · moves; drag →Ready without criteria · toast, it goes back; keyboard menu "Move to" · moves | same file, "ideas move by drag and by keyboard, and Ready is earned" |
| AC-2.17 | idea ready · Create issue (Jira simulator) · card in "Became an issue" with KEY, the issue page shows nothing in triage | same file, "an idea becomes a Jira issue through the usual dialog" |
| AC-2.18 | issue page · Send to triage · "In triage" chip · it opens the idea | same file, "a vague issue goes to triage and back" |
| AC-2.19 | OLLAMA_SIMULATOR · Suggest · "Use" on acceptance fills the list | same file, "a suggestion is used field by field" |
| AC-2.20 | ⌘K · New idea · capture · the idea is there | same file, "ideas from the command palette" |
| AC-2.21 | 320 px light/dark · page and Sheet without overflow | same file, "ideas at 320 px" |
| AC-2.22 | an idea with route `me` promoted · "Make a TODO" · a TODO tied to the new issue exists | `e2e/ideas.test.mjs` "an idea I will do becomes an issue and a TODO" |

## Traceability (every R has its ACs)

| R | AC |
| --- | --- |
| R-2.1 | AC-2.3, AC-2.9, AC-2.16 |
| R-2.2 | AC-2.1, AC-2.2, AC-2.6, AC-2.15 |
| R-2.3 | AC-2.9, AC-2.16 |
| R-2.4 | AC-2.10, AC-2.18 |
| R-2.5 | AC-2.11, AC-2.17 |
| R-2.6 | AC-2.4, AC-2.5, AC-2.22 |
| R-2.7 | AC-2.12 |
| R-2.8 | AC-2.13, AC-2.14, AC-2.19 |
| R-2.9 | AC-2.7, AC-2.8 |
| R-2.10 | AC-2.18 |
| R-2.11 | AC-2.20 |
| R-0.6 (README) | AC-2.21 |

## Edge cases
- Capture of only spaces or markers → E-2.8.
- A container removed from the tracker → `container_id` null; the card shows no project.
- A promoted issue deleted from the tracker (`issues.goneAt`) → the card shows the key struck through and "gone".
- A `fromIssue` on an issue of an archived connection → NOT_FOUND.
- Two tabs moving the same idea → last write wins. `updatedAt` is returned, and the FE refreshes on `onSettled`.
- Ollama answering after the Sheet is closed → the result is dropped (AbortController).

## Batches
1. [x] Migration, `contracts/ideas.ts`, router (list, counts, get, capture, update, move, reorder, remove, restore). R-2.1–2.3, 2.7, 2.9. AC-2.1–2.9, 2.12.
   - **Done (2026-10-30).** Decisions, to review:
     - **AC-2.1's fixture** (`contracts/__fixtures__/notepad.txt`) is an English, neutral list of seven points in the same shapes as the notepad ("1)", "3.", "-", "*", "[ ]", a blank line): the repo is public, English only, with no personal notes.
     - **Texts of `server.ideas.*`** (the spec had none): written in en and it, to review.
     - **Capture** puts the new ideas at the top of Raw in the order written (the others move down); `move` makes room at `index` in the target state.
     - **AC-2.4, 2.5** test the contract (`handoffPrompt`, `askMailUrl`); their procedures come with batch 3. The prompt's sections are always there, empty when the idea has nothing for them; a mail link keeps `@` readable (`mailto:anna@example.com`).
     - **Stored lists** are read back through their input schemas; anything else reads as an empty list.
     - `sourceItemId`/`promotedItemId` and their trigger are left to batches 3 and 4, where they are filled.
2. [x] `/ideas` page (columns and list, capture, Sheet, drag, keyboard), nav, ⌘K. R-2.11. AC-2.15, 2.16, 2.20, 2.21.
   - **Done (2026-10-30).** Decisions, to review:
     - **New texts** (the spec gave the main ones only): `pages.ideas.description`, `captureLabel`, `add`, `added`, `view`, `viewColumns`, `viewList`, `project`, `allProjects`, `noProject`, `openQuestions`, `moveTo`, `moved`, `more`, `showColumn`, `hideColumn`, `delete`, `deleted`, `discard`, `open`, `ideaTitle`, `problem`, `addCriterion`, `addQuestion`, `answer`, `route.label`, `route.none`, `remove`, `saved`, `undo`; `ui.nav.ideas` and `ui.palette.newIdea` as in the spec.
     - **`ideas.projects`**, a procedure the spec doesn't list: the projects of the user's connections in use, for the page's filter and the sheet's project (the existing `connections.containers` takes one connection at a time).
     - **The sheet's body** is a plain Textarea, without the RichText preview: the notes' editor doesn't come apart from its page, and a preview needs a Markdown-to-rich-text step the front end doesn't have. Each field saves when left; the route is a SegmentedControl with "Not chosen" first.
     - **Promoted and Discarded** start collapsed; the open/closed choice is the shared collapsed-columns setting, under "ideas:" (for those two it stores which are open).
     - **Keyboard:** a focused card moves with Alt+←/→ to the column before or after; its "…" menu has "Move to" for any column; each move is announced (`role=status`).
     - **The render budget held** only after the menu's sections were drawn by a memoized `NavRow` (`src/components/AppLayout.tsx`): with one more section, the dashboard went to 2898 component renders over its 2860. Now 1853, and the other pages about 1000 fewer each. The limits in `e2e/renders.test.mjs` are unchanged (lowering them to the new figures is for you to decide).
3. [x] Promote, handoff, askMail. R-2.5, 2.6. AC-2.11, 2.17 (and AC-2.22).
   - **Done (2026-10-30).** Decisions, to review:
     - **No trigger** for `promotedItemId`/`sourceItemId`: an idea keeps the issue's catalogue row and reads its key, title, link and "gone" from it, so a renamed key follows (tested). The stored key is only a fallback.
     - **`linkPromoted`** works from raw, refining or ready (the table's "only through linkPromoted"); on a promoted or discarded idea it is refused like a move (`terminal`). The issue must be mine, in the catalogue, not gone.
     - **The issue's description** (`issueDescription`, contract): the body, then "Done when…" with the criteria, then "Decisions taken" with the answered questions, headings in the user's language.
     - **The sheet** closes and then opens the usual "New issue" dialog; after creating it goes to the new issue, as it always does. "Copy prompt" and "Download .md" are offered on every idea (they are the "Copy as text" of D-2.2 for trackers that can't create); "Write mail" only when there are open questions; "Make a TODO" on a promoted idea routed "I'll do it".
     - **Found and fixed:** "New issue" lost its prefill when its lazy form suspended (the prefill was cleared by the first read, and React reads again after a suspended render). The prefill now stays until the dialog closes (`src/lib/createIssue.ts`); the post-it's "Make an issue" had the same risk. AC-2.17's e2e failed on it before the fix.
     - **New texts:** `createIssue`, `copyPrompt`, `downloadPrompt`, `writeMail` as in the spec; `promptCopied`, `makeTodo`, `todoMade`, `decisions`, `became`, `gone` written here.
4. [x] `fromIssue`, `forIssue`, issue chip. R-2.4, 2.10. AC-2.10, 2.18.
   - **Done (2026-10-30).** Decisions, to review:
     - **An idea from an issue** takes the issue's title and an empty body (its description would be a tracker read the spec doesn't ask for); it goes to the top of Raw. Two requests at once: the unique index lets one in, the other returns it.
     - **The issue** must be mine, in the catalogue, on a connection in use; a key on two connections without `connectionId` is CONFLICT, as elsewhere.
     - **On the issue page**, beside "TODO": "Send to triage", or "In triage" as a link to `/ideas?open=<id>`; only for an issue in the catalogue. A promoted or discarded idea is not open: the issue offers "Send to triage" again.
     - The render budget is unchanged and holds (issue page 362/375 commits).
5. LLM (after B5 batch 3). R-2.8. AC-2.13, 2.14, 2.19.

## Open questions
- **Q1, not blocking:** keyboard shortcut for "New idea" (default: none).
- **Q2, not blocking:** a draft in Outlook via Graph, which needs `Mail.ReadWrite` (default: no, `mailto:` only).
- **Q3, blocks 5:** default model (`qwen3:4b` or `gemma3:4b`, measured on the user's machines), and where Ollama runs (native on the Mac or on the LAN). **Answer 2026-10-30:** both ways, chosen by `OLLAMA_URL` only: native Ollama on the Mac (Metal) or the `ai` profile container (CPU), documented side by side for a clean machine or local Ollama. Model: measure `qwen3:4b` and `gemma3:4b` on this Mac (native `ollama serve`, ~5 GB pulled, allowed) and bring the numbers before choosing the default. **Measured 2026-10-30** (native Ollama 0.34.4 on this Mac, Metal; 5 ideas, 3 Italian and 2 English; JSON schema as `format`, temperature 0.2): qwen3:4b loads in 4.0 s, answers in 5.9–13.9 s, 5/5 valid JSON but 1/5 degenerate (a word repeated to the limit, in Italian); gemma3:4b loads in 3.1 s, answers in 8.4–11.9 s, 5/5 valid and coherent. **Default chosen by the user: `gemma3:4b`.**
- **Q4, not blocking:** shared ideas (default: no).

---
