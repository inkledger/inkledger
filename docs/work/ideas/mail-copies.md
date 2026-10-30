# Spec: keep pinned mails when Outlook deletes them (#3)

Status: planned 2026-10-29, not started. Open questions are asked when their batch is reached (README, R-0.12).


## Problem
- A pin keeps only headers: `contracts/mail.ts` says "never the body", and so does `docs/work/mail-pins.md`.
- When a mail is deleted in Outlook, the pin's link breaks and its content is lost.

## Requirements
- **R-1.1** The user MUST be able to keep an encrypted copy of every mail they pin.
  - Setting `mailCopies`: `off` (default) | `body` | `full`.
  - Server kill switch: `MAIL_COPIES=off`. When it is set, the setting is not offered and nothing is captured.
- **R-1.2** Moving the setting from `off` to anything else MUST require explicit consent in a dialog. The date of consent is saved in `mailCopiesConsentAt`. Without consent, the server refuses with E-1.1.
- **R-1.3** In `body` mode the copy MUST hold:
  - the headers (from, to, cc, date, subject);
  - the text;
  - the HTML;
  - the list of attachments (name, MIME type, size);
  - **nothing** of the attachments' content.
- **R-1.4** In `full` mode the copy MUST be the raw EML, with attachments. The decoded EML MUST be ≤ `MAIL_COPY_MAX_MB` (default 30); otherwise E-1.2.
- **R-1.5** The copy MUST be encrypted with AES-256-GCM, using the keys from `credentialKeys()` (`api/lib/crypto.ts:56`, so `CREDENTIALS_KEY` and rotation are covered).
  - The AAD MUST be `mailcopy:<userId>:<mailId>`. A copy moved to another row MUST NOT decrypt.
- **R-1.6** Capture: a capture failure MUST NOT make the pin fail. The reason goes in `mails.copy_error`.
  - From **Graph**: when it is connected and the setting is not off, `mails.pinTo`/`mails.pin` capture through `GET /me/messages/{id}/$value`. The id comes from `findByMessageId` (`microsoft.ts:262`).
  - From the **add-in**: when `Office.context.requirements.isSetSupported("Mailbox","1.14")` is true, the pane sends `item.getAsFileAsync()` (Base64 EML) to `POST /api/outlook/copy`.
  - From a **dropped .eml**: the whole file goes to `POST /api/mail/:id/copy`. Today `readMail.ts:16` reads only the first 64 KB.
- **R-1.7** HTML MUST be shown only inside `<iframe sandbox="">` (no `allow-*`), served by `GET /api/mail/:id/view` with these headers:
  - `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: private, no-store`
  - Remote resources (tracking pixels) MUST NOT load. `cid:` images become `data:` only in `full` mode.
- **R-1.8** The body MUST NOT appear in any of these:
  - logs;
  - SSR state (`api/ssrQueries.ts`);
  - the service worker cache (`public/sw.js`);
  - search indexes;
  - list responses (the `sealed` column is never selected outside the dedicated routes);
  - any LLM.
- **R-1.9** Every read of a copy (view, eml, attachment) MUST write a row in `mail_copy_reads`.
- **R-1.10** A copy whose mail has had no pins for 7 days (no `mail_links`, no `pinboard_notes.mail_id`, no `todos.mail_id`) MUST be deleted by `purgeOrphanMailCopies`. `mail_copy_reads` rows older than 365 days are deleted by `purgeMailCopyReads`.
- **R-1.11** With Graph connected, a job every 24 h MUST check up to 200 mails per user, oldest `checked_at` first:
  - not found → `gone_at = now`;
  - found again → `gone_at = null`.
  - A 429 or 503 stops the pass for that user, which resumes on the next pass.
- **R-1.12** The user MUST be able to delete one copy, or all of them.
- **R-1.13** Deleting the mail (`mails.remove`) MUST delete its copy (cascade).
- **R-1.14** `docs/outlook.md` ("What is kept", "Without inkledger": Open Archiver/MailPiler, M365 retention), `SECURITY.md` (the copies are inside `pg_dump` already encrypted; keep `CREDENTIALS_KEY` separate) and `mail-pins.md` (the reversed decision, with date and reason) MUST be updated, along with the comment in `contracts/mail.ts`.

## Out of scope
- Archiving mails that are not pinned. That is option (b) Open Archiver, which is documented but not built.
- Searching inside the body.
- Backfilling mails pinned before the setting was on (see Q4).

## Decisions
- **D-1.1** Option (a), an in-app copy of pinned mails, over (b) an archiver of all mail or (c) M365 retention.
  - *Why:* it keeps only what the user chose (minimization), needs nothing new to run, and fits the existing flow.
  - (b) and (c) are documented for anyone who needs to keep everything, or must not copy anything.
- **D-1.2** No HTML sanitizer library.
  - *Why:* a `sandbox` iframe with a `default-src 'none'` CSP blocks scripts, forms, navigation and remote resources at the browser level.
  - This is the same pattern as `api/attachments.ts:58-86`.
- **D-1.3** Parsing uses `postal-mime` (MIT, no dependencies), server side only.
  - *Why:* it handles text, html, attachments and `cid:` without native parts. Q2 must approve it.
- **D-1.4** Uploads go through Hono routes, not tRPC.
  - *Why:* the global body limit is 1 MB (`api/boot.ts:77-92`). The new routes get their own limit, as attachments (20 MB) do: `MAIL_COPY_MAX_MB * 1.37 + 64 KB` for base64.
- **D-1.5** The add-in manifest stays at `MinVersion 1.1` (it excludes no client), with a runtime check for 1.14.
  - The manifest's `<Version>` goes to `1.2.0.0`. The docs say a reinstall may be needed.
- **D-1.6** Backups are not encrypted separately.
  - *Why:* the copies are already sealed, so `pg_dump` contains ciphertext.

## Data model (`NNNN_mail_copies.sql`)
```ts
// db/schema.ts — beside mails
export const mailCopies = pgTable(
  "mail_copies",
  {
    /** One copy per mail; gone with it */
    mailId: integer("mail_id").primaryKey().references(() => mails.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** body: headers, text, html, attachment list (JSON) | full: the raw EML */
    mode: text("mode").notNull(),
    /** sealBytesFor(plain, `mailcopy:${userId}:${mailId}`) */
    sealed: bytea("sealed").notNull(),
    plainSha256: text("plain_sha256").notNull(),
    plainBytes: integer("plain_bytes").notNull(),
    /** addin | graph | eml */
    source: text("source").notNull(),
    capturedAt: ms("captured_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_mail_copies_user").on(t.userId, t.capturedAt),
    check("mail_copies_mode", sql`${t.mode} IN ('body','full')`),
    check("mail_copies_source", sql`${t.source} IN ('addin','graph','eml')`),
  ],
);
export const mailCopyReads = pgTable(
  "mail_copy_reads",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    mailId: integer("mail_id").notNull().references(() => mails.id, { onDelete: "cascade" }),
    /** view | eml | attachment */
    via: text("via").notNull(),
    at: ms("at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("idx_mail_copy_reads_at").on(t.at), check("mail_copy_reads_via", sql`${t.via} IN ('view','eml','attachment')`)],
);
// mails: + goneAt: ms("gone_at"), checkedAt: ms("checked_at"), copyError: text("copy_error")
// settings: + mailCopies: text("mail_copies").notNull().default("off"), mailCopiesConsentAt: ms("mail_copies_consent_at")
//           + check("settings_mail_copies", sql`mail_copies IN ('off','body','full')`)
```
- The plaintext for `body` mode is JSON from `contracts/mail.ts`:
  ```ts
  type MailCopyBody = {
    v: 1;
    headers: { from: string; to: string[]; cc: string[]; date: string | null; subject: string };
    text: string;
    html: string | null;
    attachments: { name: string; type: string; size: number }[];
  };
  ```
- Its zod schema is `mailCopyBodySchema`.

**Crypto** (`api/lib/crypto.ts`):
```ts
/** Bytes sealed for `scope` with the current key: 0x01 | iv(12) | tag(16) | data. */
export function sealBytesFor(plain: Buffer, scope: string): Buffer
/** The bytes sealed with sealBytesFor for the same scope (any known key); throws otherwise. */
export function openBytesFor(sealed: Buffer, scope: string): Buffer
```

## API
**Hono routes** (`api/mail/copies.ts`, registered in `api/boot.ts` next to `addin.ts`):

| Route | Auth | Input | Output |
|---|---|---|---|
| `POST /api/outlook/copy` | add-in key (`keyUser`) | JSON `{ mail: headers, eml: string /* base64 */ }` | `{ mailId, mode, bytes }` |
| `POST /api/mail/:id/copy` | session + CSRF (as the rest of `/api`) | body `message/rfc822`, raw | `{ mode, bytes }` |
| `GET /api/mail/:id/view` | session | — | HTML (R-1.7) or `text/plain` |
| `GET /api/mail/:id/eml` | session | — | `message/rfc822`, `Content-Disposition: attachment; filename="<subject>.eml"` (`full` only) |
| `GET /api/mail/:id/attachment/:n` | session | `n` int ≥ 0 | the attachment, `attachment` + sandbox CSP (`full` only) |

**tRPC** (`mails`):
```ts
copyInfo: protectedProcedure.input(z.object({ id: z.number().int().positive() }))
  // → { mode: "body"|"full", bytes: number, capturedAt: Date, goneAt: Date|null, copyError: string|null,
  //     attachments: { index: number; name: string; type: string; size: number }[] } | null
deleteCopy: protectedProcedure.input(z.object({ id: z.number().int().positive() }))      // → { ok: true }
deleteAllCopies: protectedProcedure.mutation()                                            // → { count: number }
retryCopy: protectedProcedure.input(z.object({ id: z.number().int().positive() }))        // Graph only → copyInfo
checkGone: protectedProcedure.input(z.object({ id: z.number().int().positive() }))        // Graph only → { goneAt: Date|null }
copyUsage: protectedProcedure.query()                                                     // → { count, bytes }
```
- `settings.update` accepts:
  ```ts
  mailCopies: z.enum(["off","body","full"]).optional(),
  mailCopiesConsent: z.literal(true).optional()
  ```
- Going to anything other than `off` without consent already saved and without `mailCopiesConsent: true` → E-1.1.

**Errors**

| E | Code | Key | When |
|---|---|---|---|
| E-1.1 | PRECONDITION_FAILED / 403 | `server.mails.copy.consent` | turning it on without consent |
| E-1.2 | PAYLOAD_TOO_LARGE / 413 | `server.mails.copy.tooLarge` | EML > limit |
| E-1.3 | PRECONDITION_FAILED / 403 | `server.mails.copy.off` | setting off, or `MAIL_COPIES=off` |
| E-1.4 | NOT_FOUND / 404 | `server.mails.notFound` (exists) | not mine / no copy |
| E-1.5 | BAD_REQUEST / 400 | `server.mails.copy.badEml` | not parseable |
| E-1.6 | PRECONDITION_FAILED | `server.mails.copy.noGraph` | `retryCopy`/`checkGone` without Graph |
| E-1.7 | NOT_FOUND / 404 | `server.mails.copy.bodyOnly` | eml/attachment in `body` mode |

**Simulator** (`api/mail/simulator.ts`):
- Add `GET …/messages/{id}/$value`, returning a fixture EML with text + HTML + a remote image + a 1 KB attachment.
- Add a toggle `simulatorForget(messageId)` to simulate a deleted mail.

## UI
- **Settings → Outlook** (`src/components/settings/sections/Outlook.tsx`), new group `outlook-copies`:
  - `SegmentedControl`: `settings.outlook.copies.off|body|full`.
  - Turning it on for the first time opens a consent `Dialog` (`settings.outlook.copies.consentTitle/Body/Accept`).
  - Space used (`copyUsage`, `formatBytes`).
  - "Delete all copies" opens an `AlertDialog`, then a toast with the count.
  - Searchable keywords: `settings.categories.outlook.keywords` += "copy, backup, archive, deleted".
- **`MailCard`** (`src/components/mail/MailCard.tsx:28`):
  - `Chip neutral` "Copy saved" when a copy exists.
  - `Chip warning` "Deleted in Outlook" when `goneAt`. The subject click then opens the viewer instead of the link.
  - `Chip danger` "Copy not saved", with Retry (Graph), when `copyError`.
  - Menu: Open copy · Download .eml (full) · Delete copy · Check it is still there (Graph).
  - The same entry point goes wherever a mail appears: `TodoList.tsx:870`, `PostIt.tsx:375`, `IssueMails.tsx`, `NoteMails.tsx`.
- **`MailCopyDialog`** (lazyPart, `src/components/mail/MailCopyDialog.tsx`):
  - Title: the subject.
  - A header block: from, to, cc, date.
  - `<iframe sandbox="" src="/api/mail/:id/view">` at full width, min-height 50vh, inside the `Dialog`'s scroll area.
  - An attachment list (in `full` mode, links to `/attachment/:n`; in `body` mode, names only, with the note "attachments not kept").
  - States: loading (`PageSpinner` in the region), error (`ErrorState` + Retry), no copy (`EmptyState`).
- **Add-in pane:** when 1.14 is missing and copies are on, show the note `ui.outlook.copyUnsupported`.

**i18n** (en / it):

| Key | en | it |
|---|---|---|
| `settings.outlook.copies.title` | Copies of pinned mails | Copie delle mail fissate |
| `settings.outlook.copies.off` | Off | No |
| `settings.outlook.copies.body` | Text and layout | Testo e impaginazione |
| `settings.outlook.copies.full` | Everything, with attachments | Tutto, con gli allegati |
| `settings.outlook.copies.consentTitle` | Keep copies of the mails you pin? | Tenere una copia delle mail che fissi? |
| `settings.outlook.copies.consentBody` | A copy leaves your mailbox and lives, encrypted, on this server. Your company's rules or the GDPR may not allow it: check before turning this on. You can delete every copy at any time. | La copia esce dalla casella e resta, cifrata, su questo server. Le regole della tua azienda o il GDPR potrebbero non permetterlo: verifica prima di attivarla. Puoi cancellare tutte le copie quando vuoi. |
| `settings.outlook.copies.accept` | Keep copies | Tieni le copie |
| `settings.outlook.copies.usage` | {count} copies, {size} | {count} copie, {size} |
| `settings.outlook.copies.deleteAll` | Delete all copies | Cancella tutte le copie |
| `ui.mail.copy.saved` | Copy saved | Copia salvata |
| `ui.mail.copy.gone` | Deleted in Outlook | Cancellata in Outlook |
| `ui.mail.copy.failed` | Copy not saved | Copia non salvata |
| `ui.mail.copy.open` | Open the copy | Apri la copia |
| `ui.mail.copy.download` | Download .eml | Scarica .eml |
| `ui.mail.copy.delete` | Delete the copy | Cancella la copia |
| `ui.mail.copy.check` | Is it still there? | C'è ancora? |
| `ui.mail.copy.bodyOnly` | Attachments are not kept | Gli allegati non sono tenuti |
| `ui.outlook.copyUnsupported` | This Outlook can't send the copy: sign in to the mailbox in inkledger and the server will make it. | Questo Outlook non può inviare la copia: accedi alla casella da inkledger e la farà il server. |
| `server.mails.copy.*` | (one for each E in the table) | |

## Privacy and security
- All of R-1.5, R-1.7, R-1.8, R-1.9, R-1.10.
- Ownership is checked in every route through `ownMail` (`mails.ts:79`).
- No `console.*` in the new files. The global logger already logs no bodies (`api/lib/requestLog.ts`).

## Performance
- `copyInfo` p95 < 20 ms.
- Upload of a 30 MB EML: peak RSS < 3 × the size.
- `mails.recent`, `forIssue`, `forNote` MUST NOT get slower than 5% on the perf seed (they never select `sealed`).

## AC → test

| AC | Given / When / Then | Test |
|---|---|---|
| AC-1.1 | setting off · POST /copy · 403 E-1.3, no row | `api/mail/copies.test.ts` "copies are refused while off" |
| AC-1.2 | off → body without consent · update · E-1.1 | `api/routers/settings.test.ts` "mail copies need consent" |
| AC-1.3 | body · Graph pin of the fixture · the copy has text+html+attachment names, no attachment bytes | `copies.test.ts` "body mode keeps no attachment content" |
| AC-1.4 | full · same · /eml gives the fixture byte for byte, /attachment/0 the 1 KB | `copies.test.ts` "full mode keeps the EML" |
| AC-1.5 | a copy · moved to another mail_id at the db level · open → error | `api/lib/crypto.test.ts` "a sealed copy opens only for its own mail" |
| AC-1.6 | key rotated (OLD=former) · open → ok | `crypto.test.ts` "bytes sealed with the old key still open" |
| AC-1.7 | user B · view/eml/attachment/copyInfo/deleteCopy of A's mail · 404 | `copies.test.ts` "another user's copy is not found" |
| AC-1.8 | view · headers exactly as in R-1.7 | `copies.test.ts` "the view is sandboxed" |
| AC-1.9 | viewer open in the browser · no request to the remote image host | `e2e/mail-copies.test.mjs` "a saved mail shows without loading remote images" |
| AC-1.10 | Graph fails at capture · pin ok, copyError set, Retry works | `copies.test.ts` "a failed copy never fails the pin" |
| AC-1.11 | simulator forgets the mail · job pass · goneAt set; it comes back · null | `api/mail/goneCheck.test.ts` "a deleted mail is noticed and a restored one cleared" |
| AC-1.12 | 250 mails · one pass · 200 checked, oldest first; 429 → stop | `goneCheck.test.ts` "a pass checks at most 200, oldest first, and stops on throttling" |
| AC-1.13 | mail with no pins for 8 days · purge · copy gone; with a pin · kept | `copies.test.ts` "orphan copies go after seven days" |
| AC-1.14 | 3 reads · 3 rows; rows older than 366 days · purge | `copies.test.ts` "reads are audited and purged after a year" |
| AC-1.15 | EML > limit · 413 E-1.2 | `copies.test.ts` "a copy over the limit is refused" |
| AC-1.16 | SSR of / with copies · state contains no body text | `api/ssr.test.ts` "SSR never carries a mail copy" |
| AC-1.17 | UI: consent → pin (simulator) → "Copy saved" chip → viewer shows the text → simulator forgets → "Deleted in Outlook" → click opens the copy → delete copy | `e2e/mail-copies.test.mjs` "a pinned mail survives its deletion in Outlook" |
| AC-1.18 | pane with fake Office 1.14 · pin · copy with source addin; Office 1.13 · note shown | `e2e/outlook-addin.test.mjs` "the pane sends the copy where Outlook can" |
| AC-1.19 | 320 px · settings + viewer · no overflow | `e2e/mail-copies.test.mjs` "copies at 320 px" |
| AC-1.20 | deleteAllCopies · count right, usage 0 | `copies.test.ts` "every copy can be deleted at once" |
| AC-1.21 | copies saved · `mails.recent`, `forIssue`, `forNote`, `todos.list`, `pinboard.list` · no body text, no `sealed` in any answer | `copies.test.ts` "lists never carry a copy" |
| AC-1.22 | a view, an eml and an attachment read · the request log lines · path and status only, no subject, body or file name | `api/lib/requestLog.test.ts` "a mail copy's reads log no content" |
| AC-1.23 | a mail with a copy · `mails.remove` · `mail_copies` and its reads gone | `copies.test.ts` "forgetting a mail forgets its copy" |
| AC-1.24 | docs listed in R-1.14 · review of the diff before the last batch's commit · each one says what is kept, where, how to delete it | review, written in LOOP.md |

## Traceability (every R has its ACs)

| R | AC |
| --- | --- |
| R-1.1 | AC-1.1, AC-1.2 |
| R-1.2 | AC-1.2, AC-1.17 |
| R-1.3 | AC-1.3 |
| R-1.4 | AC-1.4, AC-1.15 |
| R-1.5 | AC-1.5, AC-1.6 |
| R-1.6 | AC-1.10, AC-1.17, AC-1.18 |
| R-1.7 | AC-1.8, AC-1.9 |
| R-1.8 | AC-1.16, AC-1.21, AC-1.22 (service worker: `/api/*` is never cached, `public/sw.js:77`, unchanged) |
| R-1.9 | AC-1.14 |
| R-1.10 | AC-1.13, AC-1.14 |
| R-1.11 | AC-1.11, AC-1.12 |
| R-1.12 | AC-1.17, AC-1.20 |
| R-1.13 | AC-1.23 |
| R-1.14 | AC-1.24 |
| R-0.6 (README) | AC-1.19 |
| R-0.8 (README) | AC-1.7 |

## Edge cases
- A mail with no Message-ID: Graph capture is impossible, while add-in and .eml capture still work.
- Signed (S/MIME, `multipart/signed`) or encrypted (`application/pkcs7-mime`) mails: kept in `full` mode. In `body` mode the copy says "encrypted content not readable" and nothing fails.
- HTML with no text part: `text` is derived by stripping tags, no more than 200 KB.
- Malformed charset: postal-mime falls back to UTF-8 with replacement characters. The copy MUST still be created.
- The same mail pinned twice: one copy, replaced only if its `plain_sha256` changes.
- The setting goes from `full` to `body`: existing copies stay as they are. New copies follow the new setting.
- `CREDENTIALS_KEY` lost: `copyInfo` responds, and the viewer shows an `ErrorState` "the copy can't be opened with this server's key".

## Batches
1. [x] (2026-10-30) `crypto` bytes, migration, setting with consent, `copyUsage`, `deleteAllCopies` (R-1.1, 1.2, 1.5, 1.12; AC-1.2, 1.5, 1.6, 1.20).
2. [x] (2026-10-30) Capture from .eml and Graph, `copyInfo`, `deleteCopy`, `retryCopy`, simulator `$value` (R-1.3, 1.4, 1.6, 1.13; AC-1.1, 1.3, 1.4, 1.7, 1.10, 1.15).
3. [x] (2026-10-30) View, eml and attachment routes, audit, `MailCopyDialog`, `MailCard` and its entry points (R-1.7, 1.8, 1.9; AC-1.8, 1.9, 1.14, 1.16, 1.17 partial, 1.19).
4. [x] (2026-10-30) Add-in `getAsFileAsync` and `/api/outlook/copy` (AC-1.18).
5. [x] (2026-10-30) Gone job, `checkGone`, orphan purge (R-1.10, 1.11; AC-1.11, 1.12, 1.13, 1.17 complete).
6. Docs (R-1.14).

### Batch 2 decisions (2026-10-30, to review)
- `postal-mime` **4.0.7**: the newest release at least two weeks old (4.2.0 came out the day before); its licence is MIT-0 (MIT without the attribution clause), no dependencies.
- `mail_copies` gains `attachments` (JSON `[{ name, type, size }]`), written at capture: `copyInfo` lists them without decrypting and parsing up to 30 MB (its budget is 20 ms). Migration 0021 was regenerated with it (never left this machine).
- `copyInfo` answers `{ copy: {...} | null, goneAt, copyError }` instead of the copy or null: a failed capture has no copy but must still show its error and Retry.
- Capture runs after the pin, awaited, and never throws: Graph finds the message by its Exchange id, else by Message-ID; not signed in → nothing (a file or the add-in may bring it); not in the mailbox, Graph failing, too big, unreadable → `mails.copy_error` with the reason, cleared by the next successful capture. Pinning the same mail again replaces the copy only if its SHA-256 changed.
- Body mode: `from`/`to`/`cc` as "Name <address>", `date` as the header gives it, `text` (from the HTML without tags when there is no text part, ≤ 200 KB), `html`, attachments by name, type and size. Full mode: the raw bytes, byte for byte.
- Messages: E-1.3 is two texts: `server.mails.copy.off` (the server's switch) and `userOff` (the user's own setting, with where to turn it on); `notInMailbox`, `graphFailed`, `noGraph` (E-1.6) added. `POST /api/mail/:id/copy` has its own body limit (`MAIL_COPY_MAX_MB` + 64 KB) and stores the refusal reason on the mail too.
- In the app, a dropped or picked `.eml` is remembered beside its draft; after the pin, when copies are on, the whole file goes to `/api/mail/:id/copy` (the issue page's drop, the "Pin a mail" dialog, its pick flow); a refusal shows a toast, the pin stays.
- AC-1.4's `/eml` and `/attachment/0` reads, and AC-1.7's view/eml/attachment routes, come with batch 3 (the routes don't exist yet); here the stored bytes are compared directly.

### Batch 3 decisions (2026-10-30, to review)
- The Settings group (mode, consent dialog the first time, space used, "Delete all copies") wasn't in any batch: it came here, since AC-1.17 starts from it. It is absent when the server keeps no copies: `copyUsage` gains `available` (the feature's own router says so, R-0.1).
- The copy's header block (from, to, cc, date in the user's language) is part of the page the server serves into the sandboxed frame, escaped there: `copyInfo` never carries content. A text-only mail is shown as preformatted text in the same page. The page has its own white background (mails are written for one), not the app's theme.
- Reading routes share one check: a session, the user's own mail with a copy, else 404 (no existence leak); a copy that doesn't open with the server's keys answers 409 `server.mails.copy.locked`. Each read writes `mail_copy_reads` (view, eml, attachment); `purgeMailCopyReads` (365 days) joins the boot purge list. `/eml` and `/attachment/:n` answer 404 `bodyOnly` for a body copy; attachments always download (`Content-Disposition: attachment`, sandbox CSP, `no-store`).
- Lists (`mails.recent`, `forIssue`, `forNote`, a TODO's mail, a post-it's mail) carry `copyMode`, `copyError`, `goneAt` from one shared fragment (`mailCopyColumns`), never the copy.
- `MailCard`: "Copy saved" (neutral), "Deleted in Outlook" (warning), "Copy not saved" (danger, its reason as a tooltip, with "Try again"); a menu "Copy of {subject}": Open the copy, Download .eml (full), Delete the copy. The subject opens the copy when the mail is gone or has no link. TODOs and post-its use `MailSubject`: the same rule, plus a small "Open the copy" button. "Is it still there?" comes with batch 5 (it needs `checkGone`).
- AC-1.16 lives in `api/mail/copies.test.ts` (it needs the sign-in and copies set up there), not `api/ssr.test.ts`; it checks the dehydrated state of `/` with a copied mail on today's TODO.

### Batch 4 decisions (2026-10-30, to review)
- The pane learns the user's copy mode from `GET /api/outlook/me` (`mailCopies`); after a pin, when copies are on: Mailbox 1.14 and `getAsFileAsync` → the whole mail, base64, to `POST /api/outlook/copy` with the headers; else the note `ui.outlook.copyUnsupported`. The route saves the mail by its headers (the same row the pin made) and keeps the copy with source `addin`; refusals go on the mail like the others. One body limit for `.eml` uploads and the pane's base64 (`MAIL_COPY_MAX_MB` × 1.37 + 64 KB); the decoded size is still checked against the limit.
- D-1.5's manifest `<Version>` 1.2.0.0 is **not** applied: `ReadItem` already allows `getAsFileAsync`, nothing in the manifest changes, and a new version would only make users reinstall.
- Migration lesson: the `attachments` column (batch 2) is now `0022_mail_copy_attachments`; 0021 stays as first applied.

### Batch 5 decisions (2026-10-30, to review)
- "No pins for 7 days" needs a start: `mail_copies.orphaned_at` (migration 0023). The daily purge marks copies whose mail is pinned nowhere (no issue or note link, no TODO, no post-it), clears the mark of those pinned again, and deletes those marked more than 7 days ago: the 7 days count from the first purge that found it alone (± a day).
- The daily check (`api/mail/goneCheck.ts`, R-0.4): first pass 15 min after start, then 24 h after each end; only when background sync is on (test servers have it off); stopped at shutdown. Per signed-in user, up to 200 mails with a Message-ID, longest unchecked first (`checked_at` nulls first); looked for by Message-ID in the whole mailbox (Deleted Items included: a mail is gone only when it's really gone); not found → `gone_at` (kept from the first time), found → cleared. Any refusal (429, 503, signed out) stops that user's pass.
- `checkGone` (E-1.6 when not signed in; a mail without Message-ID can't be looked for) and the card's "Is it still there?" (only when signed in) do the same for one mail.
- AC-1.17's "the simulator forgets" is done in the e2e by changing the mail's Message-ID in the database to one the simulated mailbox doesn't have, then "Is it still there?": the server can't be switched from the browser test; the switch itself (`simulateForget`) is covered by `goneCheck.test.ts`.

## Open questions
- **Q1, blocks all:** confirm reversing "never the body", off by default. **Answer 2026-10-30: yes**, off by default, consent required.
- **Q2, blocks 2:** OK to add the `postal-mime` dependency. **Answer 2026-10-30: yes.**
- **Q3, not blocking:** 30 MB limit, 7-day orphan purge, 365-day audit (defaults as written). **Answer 2026-10-30: as written.**
- **Q4, not blocking:** backfill copies of mails already pinned (default: no). **Answer 2026-10-30: no backfill.**

---
