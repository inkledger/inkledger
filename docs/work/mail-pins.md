# Status: Pinned mails (Outlook / Microsoft 365)

Batch 1 partial (2026-10-27): issues, TODOs and post-its done; Markdown notes pending. Not pushed.

## Goal and completion criteria
- Pin a specific mail to an issue, a Markdown note, a TODO or the pinboard, to get back to the
  conversation in Outlook.
- Works with every client: Outlook on the web, new Outlook, classic Outlook, mobile.
- Only headers are kept (subject, sender, date, Message-ID, Exchange id, link): never the body.

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

## Batches
- [x] 1a. Parsers `contracts/mail.ts` (+ `api/mail.test.ts`)
- [x] 1b. Schema `mails`, `mail_links`, `todos.mail_id`, `pinboard_notes.mail_id`
- [x] 1c. API `mails.*`, `pinboard.pinMail`, TODO `mailId` (+ `api/routers/mails.test.ts`)
- [x] 1d. UI: issue section (button, .eml/link drop), TODO chip and menu, mail post-it
- [x] 1e. e2e `e2e/mail-pins.test.mjs`
- [ ] 1f. Markdown notes: mail list under a note, "Insert link" in the toolbar (after the notes work lands)
- [ ] 2. Outlook add-in (manifest, task pane, scoped key, HTTPS on the tailnet)
- [ ] 3. Graph device-code sign-in (optional)

## Checks
| Command | Scope | Result |
| ------- | ------ | ------ |
| `vitest run api/mail.test.ts` | parsers | pass (10) |
| `vitest run api/routers/mails.test.ts` | save, de-dup, pins, key rename, notes, TODO, post-it | pass (5) |
| `vitest run api` | API incl. parity, idor, migrations | pass |
| `tsc -b`, `eslint .`, design check | staged snapshot of each commit | pass |
| `node --test e2e/mail-pins.test.mjs` | link, .eml drop, pinboard, TODO | pass |
| Harness screenshots | issue section, dialog, post-it light/dark | ok |

## Blocks and next action
- 1f waits for the Markdown notes work in progress.
- Next: batch 2 (add-in) once the user confirms the HTTPS address on the tailnet.
