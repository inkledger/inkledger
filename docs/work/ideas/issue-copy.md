# Copy an issue for an agent

## 1. Status
2026-10-30: specified, answers in §14. **First in the loop's order**, before every other doc. C1–C4 done; C4's check on a real GitHub issue pending (Q3).

## 2. Problem
The user passes issues to an AI agent by hand: copy, paste into the agent. The issue page can copy the key and the branch, not the issue. Attachments make it worse: their tracker links need the tracker login, and the app's own links (`/api/attachments/:id/content`, `api/attachments.ts:127`) need the app's session cookie, so an agent opening them gets 401. Triage (`docs/work/ideas/triage.md`) needs the same text to hand an idea's issue to an agent.

## 3. Requirements
- **R-6.1** The issue page MUST offer "Copy for an agent", which puts Markdown on the clipboard: a header (title, KEY, tracker link, status, type), the description, and `## Attachments` listing every attachment of the issue (also those not named in the text). No comments.
- **R-6.2** The description MUST be serialized by `toMarkdown(doc, link)` in `contracts/richtext.ts`, covering every node of `RichDoc`: GFM tables, panels as `> **Note:**`-style quotes, mentions `@name`, code blocks fenced longer than any backtick run inside, Markdown characters in text escaped. An attachment image → `![name](link)` when `link(name)` resolves, else `[attachment: name]`; an outside image → `![alt](url)`; inline `attachment{name}` → `[name](link)` or `[attachment: name]`.
- **R-6.3** Every attachment link MUST point at this app (`<origin>/api/shared/<token>`), signed and expiring, so it downloads **without** any login. The origin is the request's (`ctx.req`, already filtered by `ALLOWED_HOSTS`).
- **R-6.4** The duration MUST be chosen at copy time among 15 min · 1 h · 4 h · 24 h, with a default in Settings; never more than 24 h (server-enforced on sign and on verify).
- **R-6.5** The user MUST be able to revoke every link issued so far, at once ("Revoke all links"): links signed before stop working immediately.
- **R-6.6** A refused link (bad signature, expired, over 24 h, revoked, user/connection gone or archived, attachment gone) MUST answer 404 with no detail.
- **R-6.7** The token MUST be HMAC-SHA256 with a key derived by HKDF (info `inkledger:share-link`) from `credentialKeys()` (`api/lib/crypto.ts:56`); verify tries every known key, so `CREDENTIALS_KEY` rotation keeps unexpired links working.
- **R-6.8** Triage: `ideas.handoff` MUST add `## Issue` built with `issueMarkdown` and signed links when the idea has a source or promoted issue.
- **R-6.9** GitHub (batch C4): images and files in the body (`github.com/user-attachments/…`, `*.githubusercontent.com`) MUST become attachments served through the same signed route with the connection's token; the token never appears in the text.

## 4. Out of scope
Comments; other trackers than Jira and GitHub; uploading anything to the agent; per-link revocation; a public base URL setting.

## 5. Decisions
- **D-6.1** Stateless signed tokens + a per-user generation counter. *Why:* no table of links to grow and purge; revoke-all is one increment (user answer 2026-10-30).
- **D-6.2** The Markdown is built on the server (`issues.copyForAgent`). *Why:* only the server can sign; the description and attachments are fetched there anyway.
- **D-6.3** Origin from the request. *Why:* there is no public URL setting (`api/lib/env.ts`); the browser's origin is the one the user (and an agent on the same machine or tailnet) reaches.
- **D-6.4** `toMarkdown` in `contracts/`. *Why:* shared, pure, next to `plainText` (`contracts/richtext.ts:87`).

- **D-6.5 (C1, from the code)** A table without a header row gets an empty header (Markdown needs one); a line break inside a cell becomes a space; a panel is a quote opening with its kind (`> **Warning:**`).
- **D-6.6 (C2, to review)** The durations are a group inside the Copy menu, not a submenu: at 320 px a submenu opened beside the menu and left the screen (caught by AC-6.11). The menu's name became "Copy key, branch name or the issue".
- **D-6.7 (C2)** Strings live under `pages.issueDetail.*` (`copyForAgent`, `copyFor`, `copyDefault`, `copiedUntil`) beside the other copy items, not `ui.issue.*`; Settings under `settings.links.agent.*` as written.
- **D-6.8 (C2)** A shared link keeps the attachment's real type (PNG stays `image/png`, so an agent can read it) but is always `Content-Disposition: attachment`, sandbox CSP, `nosniff`, `no-store`, `no-referrer`; unknown types are `application/octet-stream` as on the existing route.
- **D-6.9 (C2)** The clipboard is claimed at the click with a `ClipboardItem` whose text arrives later (`copyLater`, `src/lib/issues.ts`): Safari refuses a write after the network wait. Rate limit: 120 shared downloads a minute per address.
- **D-6.10 (C2)** The e2e serves its stand-in Jira on this machine's private IPv4: trackers on loopback are refused by design (`api/lib/security.ts`). `copyForAgent` needs the issue synced (its title and status come from the stored row); a remote-only issue doesn't offer it.
- **D-6.11 (C3, to review)** The prompt's issue is the one the idea became, else the one it came from, under `## Issue` before `## Constraints`, its headings two levels deeper (`### KEY: title`, `#### Description`). When its tracker can't give it now, the prompt comes without it rather than failing. The shared code moved to `api/issues/agentCopy.ts` (used by `issues.copyForAgent` and `ideas.handoff`). "Copy prompt" uses the Settings default duration (no `minutes` sent).
- **D-6.12 (C4, user's choice 2026-10-30: body_html)** GitHub pastes (`github.com/user-attachments/assets|files/…`, the older `*user-images.githubusercontent.com`) are found in the body and listed as attachments (images named `image-<id>`, files by their name); in the copied text their URLs become the app's signed links (`mapUrls`, `contracts/richtext.ts`). On download the route reads the issue with `Accept: application/vnd.github.full+json` (no ETag cache: its signed links last minutes), takes the signed link with the same asset id from `body_html` and fetches it **without** the token (only the API call carries it); a public repository's link is fetched as it is. A link no longer in the issue (edited away) is 404. Hosts allowed: github.com, private-user-images, user-images, objects.githubusercontent.com (GitHub Enterprise not covered). The payload gains `k` (the issue key). The adapter's `attachments.read` capability stays false: it drives the issue page's attachment list, which GitHub still doesn't have.

## 6. Data model (`0020_share_links.sql`)
```ts
// settings: +
shareLinkMinutes: integer("share_link_minutes").notNull().default(60),
shareLinkGeneration: integer("share_link_generation").notNull().default(0),
// + check("settings_share_link_minutes", sql`share_link_minutes BETWEEN 5 AND 1440`)
```
Token payload (base64url JSON, then `.` + base64url HMAC):
```ts
type SharePayload = { v: 1; u: number /* user */; c: number /* connection */; a: string /* attachment id (Jira numeric, GitHub url hash) */; iat: number; exp: number /* epoch ms */; g: number /* generation */ };
```
`api/lib/shareLinks.ts`: `signShare(p: Omit<SharePayload, "v">): string`, `verifyShare(token: string, now: number): SharePayload | null` (signature, `exp ≥ now`, `exp − iat ≤ 24 h`); the route then checks `g`, user, connection.

## 7. API
```ts
// issues
copyForAgent: protectedProcedure.input(z.object({
  issueKey: issueKeyInput, connectionId: z.number().int().positive().optional(),
  minutes: z.number().int().min(5).max(1440).optional(), // default settings.shareLinkMinutes
})).mutation() // → { markdown: string; expiresAt: Date }
// settings
update: + shareLinkMinutes: z.number().int().min(5).max(1440).optional()
revokeShareLinks: protectedProcedure.mutation() // → { ok: true }
// ideas (C3)
handoff: + minutes: z.number().int().min(5).max(1440).optional()
```
Route `GET /api/shared/:token` (`api/attachments.ts`, streaming extracted from :131-155 into a helper shared with the existing route); no session, no CSRF; rate-limited with `api/lib/security.ts` limiter; headers: `Content-Disposition: attachment; filename=…`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, the sandbox CSP of `attachmentHeaders`.

| E | Code | Key | When |
|---|---|---|---|
| E-6.1 | NOT_FOUND | `server.issues.notFound` (exists) | issue not mine |
| E-6.2 | 404 (route) | none (empty body) | any refused token (R-6.6) |
| E-6.3 | BAD_REQUEST | zod | minutes out of 5–1440 |

## 8. UI
- `src/pages/IssueDetail.tsx` Copy dropdown (:471-496): submenu "Copy for an agent" → 15 min · 1 h · 4 h · 24 h, the Settings default marked "(default)". Toast through `useIssueActions().copy` (`src/hooks/useIssueActions.ts:55`): "Copied · links valid until {time}". Busy while the mutation runs; error → `toastError`.
- Settings → Links section (`src/components/settings/sections/Links.tsx`), new group `links-agent`: duration `Select`, "Revoke all links" (`AlertDialog`, then toast). Keywords += "agent, share, attachment, copy".
- `IdeaSheet` "Copy prompt" / "Download .md" (C3): default duration.

| Key | en | it |
|---|---|---|
| `ui.issue.copyForAgent` | Copy for an agent | Copia per un agente |
| `ui.issue.copyFor` | Links valid {duration} | Link validi {duration} |
| `ui.issue.copyDefault` | {duration} (default) | {duration} (predefinito) |
| `ui.issue.copiedUntil` | Copied · links valid until {time} | Copiato · link validi fino alle {time} |
| `settings.links.agent.title` | Links for agents | Link per gli agenti |
| `settings.links.agent.body` | Copying an issue for an agent turns its attachments into links anyone holding them can open, until they expire. | Copiando una issue per un agente, gli allegati diventano link che chiunque li abbia può aprire, fino alla scadenza. |
| `settings.links.agent.duration` | Default duration | Durata predefinita |
| `settings.links.agent.revoke` | Revoke all links | Revoca tutti i link |
| `settings.links.agent.revokeConfirm` | Every link copied so far stops working now. | Tutti i link copiati finora smettono di funzionare subito. |
| `settings.links.agent.revoked` | Links revoked | Link revocati |
| `ui.markdown.attachments` (in the copied text: English template) | — | — |

## 9. Privacy and security
A link is a bearer credential for one attachment for ≤ 24 h: the Settings text says so. Tokens never logged (`api/lib/requestLog.ts` must drop the path segment after `/api/shared/`). No tracker or GitHub token ever in the text. Constant-time comparison. 404 on every refusal (no oracle).

## 10. Performance
`copyForAgent` p95 < 300 ms on the Jira simulator (one description + one attachments call, cached queries reused). Issue page render budget unchanged (the submenu mounts on open).

## 11. AC → test
| AC | Given / When / Then | Test |
|---|---|---|
| AC-6.1 | a doc with every node type · `toMarkdown` · expected Markdown | `contracts/richtext.test.ts` "every rich text node becomes Markdown" |
| AC-6.2 | text with `*_[]#` and code with ``` · escaped, fence longer | same, "Markdown characters and fences are safe" |
| AC-6.3 | image by name with and without link · `![name](link)` / `[attachment: name]` | same, "attachments become links only when they resolve" |
| AC-6.4 | `issueMarkdown` · header, description, every attachment listed | `contracts/issueCopy.test.ts` "an issue copies with its header and attachments" |
| AC-6.5 | tampered / expired / iat→exp > 24 h · null; old key · ok | `api/lib/shareLinks.test.ts` "a share link holds only while signed, fresh and short" |
| AC-6.6 | Jira simulator · copyForAgent · links fetch the file with no cookie | `api/attachments.test.ts` "a shared link downloads without a session" |
| AC-6.7 | revokeShareLinks · the earlier link · 404; archived connection · 404 | same, "revoked and orphaned links are not found" |
| AC-6.8 | user B · copyForAgent on A's issue · NOT_FOUND | `api/routers/issues-copy.test.ts` "another user's issue can't be copied" |
| AC-6.9 | minutes 2000 · BAD_REQUEST; omitted · settings default | same, "the duration is bounded and defaults to the setting" |
| AC-6.10 | UI: Copy → for an agent → 1 h · clipboard has header and `/api/shared/`; fetch without cookie 200; Revoke in Settings · 404 | `e2e/issue-copy.test.mjs` "an issue is copied for an agent with working links" |
| AC-6.11 | 320 px light/dark · menu and Settings group without overflow | same, "copy for an agent at 320 px" |
| AC-6.12 | idea with a source issue · handoff contains `## Issue` and a signed link | `api/routers/ideas.test.ts` "the agent prompt carries its issue" |
| AC-6.13 | GitHub simulator body with a user-attachments image · copy · signed link serves the bytes, no token in text | `api/providers/github/attachments.test.ts` "GitHub images are shared through the app" |

## 12. Edge cases
Empty description → header + "(no description)". Attachment named twice → listed once. Attachment deleted on the tracker after copy → 404. Filename with quotes/newlines → sanitized in `Content-Disposition`. Clipboard denied → toast error, nothing lost. Read-only mode (`PROVIDERS_READ_ONLY=1`) → works (reads only).

## 13. Batches
- [x] **C1** `toMarkdown`, `issueMarkdown`. R-6.2. AC-6.1–6.4.
- [x] **C2** migration, `shareLinks`, `/api/shared/:token`, `copyForAgent`, Settings group, issue-page submenu. R-6.1, 6.3–6.7. AC-6.5–6.11.
- [x] **C3** triage handoff. R-6.8. AC-6.12.
- [x] **C4** GitHub attachments. R-6.9. AC-6.13.

## 14. Open questions
- **Q1, answered 2026-10-30:** links signed, duration chosen at copy time and default in Settings, max 24 h; "Revoke all links" yes; content header + description; Jira first then GitHub, proxied through the app.
- **Q2, to review at C2:** the Settings default is 1 h (proposal approved with the plan 2026-10-30).
- **Q3, open (C4):** which real GitHub issue with a pasted image may I read (one read-only GET with your connection) to confirm `body_html` carries the signed link as the simulator does?
