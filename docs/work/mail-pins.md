# Status: Pinned mails (Outlook / Microsoft 365)

Done (2026-10-29): mailbox search (Microsoft sign-in), a two-step "Pin a mail" from anywhere, the Outlook add-in (a page of the app's build) on local HTTPS, Markdown notes, Settings → Network. Committed and pushed. User guide: docs/outlook.md.

## Goal and completion criteria
- Pin a specific mail to an issue, a Markdown note, a TODO or the pinboard, to get back to the
  conversation in Outlook.
- Works with every client: Outlook on the web, new Outlook, classic Outlook, mobile.
- Only headers are kept (subject, sender, date, Message-ID, Exchange id, link): never the body.
  **Reversed 2026-10-30** (user's answer, `docs/work/ideas/mail-copies.md` Q1): a pinned mail
  may also keep an encrypted copy of its body, off by default and only after the user's consent,
  because a pin whose mail was deleted in Outlook opened nothing.

## Constraints and out of scope
- Reading the mailbox through Graph (`Mail.Read`) usually needs tenant admin consent, so it is
  layer 3 and optional; layers 1 and 2 must work without it.
- The Markdown notes were being edited live by someone else (NoteEditor, MarkdownToolbar): their
  files are not touched until that work lands.

## Decisions
- Layered: (1) paste a link / drop an .eml, (2) Outlook add-in "Pin to inkledger", (3) Graph sign-in.
- One `mails` row per message and user, de-duplicated by Message-ID, else by Exchange id; a later
  copy completes it and never blanks a subject typed by hand.
- `mail_links` holds the pins to issues and notes (exactly one target, checked); TODOs and post-its
  carry `mail_id` themselves, as they do for notes and TODOs.
- Issue pins follow key changes: `mail_links_link_item` trigger + `inkledger_issue_keyed` recreated
  with `mail_links` (migration `0013_mail_pins.sql`).
- Outlook links are stored in the deeplink form (`/mail/deeplink/read/{REST id}`); the legacy
  `outlook.office365.com/owa/?ItemID=` becomes a link on `outlook.office.com`.
- Opening an Outlook link the first time goes through `ExternalLink` ("Allow always" is one click).
- Forgetting a mail unpins it everywhere; TODOs about it stay, without it.

## Round 2: why
Batch 1 relied on pasting an Outlook web link, but new Outlook for Mac (the user's client) has no link to copy. A mail could only be pinned from inside an issue or a TODO, with its subject typed by hand. Round 2 cuts pinning to "search, click", from either side.

## Batches
- [x] 1a. Parsers `contracts/mail.ts` (+ `api/mail.test.ts`)
- [x] 1b. Schema `mails`, `mail_links`, `todos.mail_id`, `pinboard_notes.mail_id`
- [x] 1c. API `mails.*`, `pinboard.pinMail`, TODO `mailId` (+ `api/routers/mails.test.ts`)
- [x] 1d. UI: issue section (button, .eml/link drop), TODO chip and menu, mail post-it
- [x] 1e. e2e `e2e/mail-pins.test.mjs`
- [x] 1f. Markdown notes: mails under a note (`NoteMails`), pinning one writes its link at the cursor
- [x] 2. Outlook add-in: `/api/outlook/{manifest.xml,taskpane.html,taskpane.js,me,issues,pin}`, key in `mail_addin_keys` (hash only, opens only these routes), HTTPS via `scripts/outlook-https.mjs` on the local machine/LAN (not the tailnet, as asked)
- [x] 3. Microsoft sign-in (device code, `Mail.Read`), `mails.search`, link filled by Message-ID; tokens sealed per user (`mail_accounts`, `sealFor`); simulator `MAIL_SIMULATOR=1`
- [x] UX: two-step picker (mail, then where: issue / new TODO / pinboard), palette "Pin a mail…", drop or paste a mail anywhere, Settings → Outlook
- [x] Add-in pane rebuilt as a React page of the build (`outlook.html`, `src/outlook/`): design system, theme colour, Outlook's language; board choice (or a new board), TODO day, copy link, "pinned already", pin reminder; nothing wider than the pane (e2e at 320/480 px)
- [x] HTTPS proxy as a LaunchAgent (`outlook-https.mjs agent`)
- [x] Outlook mail links open without the domain prompt (`ExternalLink`)
- [x] Settings → Network: every host the server calls (`api/lib/egress.ts`)
- [ ] The user's real-world checks: Entra app + `MS_CLIENT_ID` (mailbox search), add-in re-added after the 1.1 manifest, pane pinned

## Checks
| Command | Scope | Result |
| ------- | ------ | ------ |
| `vitest run api/mail.test.ts` | parsers | pass (10) |
| `vitest run api/routers/mails.test.ts` | save, de-dup, pins, key rename, notes, TODO, post-it | pass (5) |
| `vitest run api` | API incl. parity, idor, migrations | pass |
| `tsc -b`, `eslint .`, design check | staged snapshot of each commit | pass |
| `node --test e2e/mail-pins.test.mjs` | link, .eml drop, pinboard, TODO | pass |
| Harness screenshots | issue section, dialog, post-it light/dark | ok |
| `vitest run api/mail` | sign-in, consent, refresh, search, pinTo, keys, add-in routes | pass (22) |
| `node --test e2e/mail-pins.test.mjs` | link/.eml, mailbox search → issue, .eml anywhere → TODO, note | pass (3) |
| task pane with a stubbed Office.js | pin section, issues, it-IT | ok (screenshot) |
| `outlook-https.mjs cert/serve` against dev :3000 | manifest over HTTPS, CSP, no X-Frame-Options | ok |
| `node --test e2e/outlook-addin.test.mjs` | the pane end to end with a stubbed Office.js, widths 320/480 | pass |
| staged snapshot of each commit | tsc, eslint, design check, parity, targeted vitest | pass |
| full `vitest run` | 2340 tests | pass |
| full e2e | all but `the open hole on the Dashboard…`, `the day is never logged on guesses…` (also failing before this work: time of day, after midnight) and `React work per five minutes` (failing on the base commit too) | see note |

## Blocks and next action
- Microsoft side, which only the user can do: register the Entra app (docs/outlook.md), then sign in. The tenant may require admin consent for `Mail.Read`; the add-in and drop paths do not need it.
- Migrations: mine committed as `0014_mail_accounts` and `0015_egress_hosts`; the other stream's (uncommitted) planned-entries migration moved to `0016_planned_entries` with its SQL unchanged and a newer `when`, so it is never skipped. The dev database's applied rows were re-dated to match (dev only).
