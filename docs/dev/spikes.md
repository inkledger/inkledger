# Spikes

Short checks run before the work that depends on them, so an assumption is tested on real software before code is built on it. Each concluded entry: what was asked, how it was checked, the answer, and what it decides.

Until a spike passes, everything that depends on it holds its conservative value; a spike only ever promotes it.

## pg_trgm and full-text search: compatibility (before the platform schema migration)

- **Asked:** can fuzzy search (`pg_trgm`) and `tsvector` indexes run both in the tests (PGlite) and in production (Postgres)?
- **Checked:** PGlite 0.5.10 (PostgreSQL 18.6 on wasm) with `extensions: { pg_trgm }` from `@electric-sql/pglite/dist/contrib/pg_trgm.js`; 5,000 rows, a GIN `gin_trgm_ops` index and a GIN `to_tsvector('simple', …)` index. Postgres 17 (the `db` service): `CREATE EXTENSION pg_trgm` (1.6).
- **Answer:** both work, with the same indexes in both. Timings are indicative only (single runs, no warm-up, 5,000 rows): a misspelled similarity query (`%`) about 14 ms in PGlite, full text about 2 ms. This shows compatibility, not production-scale performance; search gets its own measurement on real volumes when it is built (WP-24).
- **Decides:** search uses `pg_trgm` + `tsvector` with the `simple` configuration (content mixes Italian and English). The test connection loads the extension; the migration creates it with `IF NOT EXISTS`.

## Password hashing cost (before local accounts)

- **Asked:** which scrypt cost suits the production host?
- **Checked:** inside the production container (8 cores, 8 GB, Node's default 4-thread pool), after one warm-up hash.
  - First pass, `crypto.scryptSync`, 5 hashes per setting: N=2^14 36 ms · **N=2^15 66 ms** · N=2^16 136 ms.
  - At N=2^15, 11 runs each: sequential median 70 ms (min 64, max 77); 4 concurrent `crypto.scrypt` calls, wall time per batch median 69 ms (min 66, max 94), peak process RSS 183 MB (the whole server process included).
- **Answer:** N=2^15 costs about 70 ms, and four at once run in parallel in about the same time.
- **Decides:** N=2^15, r=8, p=1, at most 4 hashes at a time. Memory: each N=2^15 hash needs 128·N·r = 32 MB, so four at once need about 128 MB; `maxmem` (64 MB) is only the ceiling passed to each call, not what it allocates. The parameters are stored with each hash, so they can be raised later.

## Jira Server (Italian locale), transitions and priorities (before transitions with fields and categories)

- **Asked:** does Jira Server describe the fields a transition requires, in which order are priorities, and can resolutions tell "cancelled" from "done"?
- **Checked:** read-only calls (`JIRA_READ_ONLY=1`) to a Jira Server 8.x with Italian locale: `/issue/{key}/transitions?expand=transitions.fields`, `/priority`, `/resolution`, `/statuscategory`.
- **Answer:**
  - Transitions come with `fields` when expanded, but `hasScreen` is not returned on Server: required fields can only be read from `fields[*].required`.
  - Six priorities, localized, in Jira's order (highest first).
  - Resolutions are localized names (done, won't do, duplicate, cannot reproduce…) with instance-specific ids: no portable meaning.
  - Status categories keep their keys (`new`, `indeterminate`, `done`) under localized names.
- **Decides:**
  - The transition form is built from `fields[*].required` only; `hasScreen` is never relied on.
  - `priority_rank` (0 = highest … 4) is the native position scaled onto 0–4 (`round(i × 4 / (n − 1))`), on purpose a coarse scale shared by every provider: with more than five priorities some share a rank (six give 0, 1, 2, 2, 3, 4). With one priority, the rank is 2 (no information either way); with none, null. The native order and name are kept for display and exact sorting within one connection.
  - Jira's `done` category maps to `done`, whatever the resolution; `cancelled` only by the user's mapping. WP-14 tests that no resolution turns an issue `cancelled` by itself.
  - Categories are always read by key, never by name.

## GitHub: conditional requests and notifications (before GitHub polling and inbox)

- **Asked:** does a 304 cost a request of the primary budget, and does the device-login token read the notifications?
- **Checked (2026-10-20):** read-only calls with the token of the inkledger OAuth App (device flow; scopes `notifications, project, repo`), REST API 2022-11-28: `/issues?filter=all&state=all` twice (the second with `If-None-Match`), `/rate_limit`, `/notifications?all=true` twice (the second with `If-Modified-Since`), GraphQL `viewer.projectsV2`.
- **Answer:**
  - The conditional repeat answers 304 and `X-RateLimit-Remaining` stays where it was (4979 → 4979, `used` 21 → 21): a 304 is free.
  - `/notifications` answers with `X-Poll-Interval: 60`; its conditional repeat is a free 304 too. Each thread has `reason`, `unread`, `updated_at`, `subject` (title, url, type) and `repository`.
  - GraphQL reads `projectsV2` with the `project` scope; this account has none, so a Status field's write stayed untested.
- **Decides:**
  - `github-etag` passes: the GitHub adapter polls with ETags (a page that didn't change costs nothing).
  - `github-notifications` passes for the device-login token: the inbox is GitHub's notifications, polled no faster than `X-Poll-Interval`.
  - `github-projects` stays pending (reading works; writing a Status needs a project to try on).
  - `github-transfer` stays pending: no transferred issue to observe.

## GitLab (built on a simulator, not verified on a real account)

The GitLab adapter (`api/providers/gitlab/`, status `experimental`) was written from GitLab's documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real server. Each assumption below is checked on a real account (gitlab.com free, plus one self-managed) before the adapter leaves `experimental`; until then **Current** holds. The three ids that also sit in the table below (`gitlab-statuses`, `gitlab-timelog`, `gitlab-rate-headers`) keep their rows there; they are repeated here so the whole list is in one place.

1. **Assigned-issues feed** (`GET /issues?scope=assigned_to_me&state=all&order_by=updated_at&sort=asc&updated_after=…`, offset pages of 50 followed by the `Link: rel="next"` header, key from `references.full`).
   - Current: the feed is complete and ordered; `updated_after` is inclusive; a pass overlaps its checkpoint by 60 s; `scope` must be given (the default is `created_by_me`) and `state` is `opened|closed|all`.
   - If passes: nothing changes.
   - If fails: if `updated_after` is exclusive or coarser than a second, widen the overlap; if offset paging skips rows while issues change under it, read with keyset pagination where the instance offers it.
2. **Two ids** (`id` of the instance, `iid` of the project): `GET /issues/:id` is administrators only, so an issue is found again by its project (id first, then the key's path) and `iid`, accepted only when its `id` is the one asked for.
   - Current: the project's id keeps working across a rename and a transfer between groups; the old path of a renamed project is a 404 through the API (not a redirect) and may be taken by another project.
   - If passes: nothing changes.
   - If fails: if the API follows redirects from an old path, the id check already guards it; the only change is the test that expects `none` for an old key.
3. **GraphQL `issue(id: IssueID!)`** (root query, any user) and **`timelogs(username, startDate, endDate, first, after)`** (root query).
   - Current: both exist on gitlab.com and self-managed 16+, answer `null` for what the user can't see, and `startDate`/`endDate` given as bare dates snap to whole days in UTC (the adapter reads whole UTC days one day wider than its 30-day window at each end, and ends tomorrow).
   - If passes: nothing changes.
   - If fails: where `issue(id:)` is missing, the successor of a moved issue and a lookup by remote id use the project from the key only (moved issues then read as `missing`); where `timelogs` is missing or takes other arguments, time is read per issue from `project.issue.timelogs` for the assigned issues.
4. **Moved issues** (`moved_to_id` on the old issue, which stays, closed).
   - Current: the old issue is reported as gone `transferred` with its successor (found through GraphQL), and the successor arrives in the feed because assignees are copied.
   - If passes: nothing changes.
   - If fails: if `moved_to_id` is absent from the list payload, read it from the single-issue endpoint; if the successor has no assignee, it is not in the feed and the successor reference is still given.
5. **Scoped labels** (`workflow::doing`): adding one removes the others of its scope; the adapter also removes the old one explicitly (`add_labels` and `remove_labels` in one `PUT`).
   - Current: a scope is everything before the last `::`; two labels of one scope at once give no label status (the issue reads Open).
   - If passes: nothing changes.
   - If fails: if the API keeps both labels when only `add_labels` is sent, the explicit removal already covers it.
6. **Label status categories** come from the connection's options (`workflow.categories`), never from names. The status carries `categoryOrigin: mapping` with the connection's id and version 1 until the engine's own mapping table exists.
   - Current: unlisted labels mean nothing.
   - If passes: the options become a real mapping row.
   - If fails: not a service check; decide with the engine's mapping (WP).
7. **Quick actions in comments**: a note line starting with `/` runs as a command (`/close`, `/assign`, `/spend`), and a note of only commands is not created (202). The adapter writes `\/` for such lines outside fenced code.
   - Current: `\/close` is plain text and renders as `/close`; fenced code is left alone by GitLab.
   - If passes: nothing changes.
   - If fails: if the backslash form still runs, put a zero-width space after the slash instead and add a conversion warning.
8. **System notes** (`system: true`) are mixed into `GET …/notes`; the adapter leaves them out of comments. Label events whose label was deleted have `label: null`.
   - Current: as written.
   - If passes / fails: a different field name means a filter change only.
9. **Subscribe** answers 304 when already subscribed (and for unsubscribing when not): treated as success.
   - Current: as written.
   - If fails: other statuses (200/201) are already successes; a 4xx would become the mapped error.
10. **Webhooks**: the secret arrives as is in `X-Gitlab-Token` (nothing is signed); the delivery has `X-Gitlab-Event-UUID` (or `Idempotency-Key` on versions without it); `object_attributes.updated_at` is `2026-10-21 10:00:00 UTC` on older versions and ISO on newer. Events: `Issue Hook` and `Note Hook` with `noteable_type: Issue` (confidential variants included). The provider contract has no webhook operation yet: `gitlabWebhook` is exported for the receiving route.
    - Current: all signals (see the webhook rows below: a `webhook-gitlab-<event>` row is added before any is declared `full`).
    - If passes: promote nothing here; payload spikes decide.
    - If fails: a different header name is a one-line change in `gitlabWebhook`.
11. **Self-managed avatars** may be paths on the instance (`/uploads/-/system/user/avatar/…`): resolved against the instance's web address; the API root may carry a path prefix (`https://host/gitlab/api/v4`).
    - Current: as written; links pasted from the instance are accepted under that prefix only.
    - If fails: an avatar that can't be resolved is shown without a picture, not an error.
12. **`gitlab-statuses`**: Premium work item statuses readable and settable through GraphQL.
    - Current: `boolean` + `labelSet` only.
    - If passes: add `itemState` where the plan has it. If fails: stays.
13. **`gitlab-timelog`**: `timelogCreate` with `spentAt` (an entry on a chosen day), and deleting one.
    - Current: two ways, chosen by the server's GraphQL schema (`legacyTime.ts`, kept an hour per server): `Query.timelogs` to read (14+), `timelogCreate`/`timelogDelete` to write (15+); without them, `/spend <length> <day>` in a note logs, `/spend -<length> <day>` takes back, and the system notes ("added 1h 30m of time spent at 2026-10-21") are the entries (`n<note id>`, day only). Seen on a real 13.6.1-ee: no `Query.timelogs`, no timelog mutation, `Timelog` only under `Group.timelogs` (off there); system note text and the quick action's 202 not yet checked by a real write.
    - If passes: write `entry`, update `recreate`, delete. If fails: stays read only.
14. **`gitlab-rate-headers`**: 429 and `RateLimit-*` agree. The probe reads `RateLimit-Limit` (per minute on gitlab.com) as `perHour = limit × 60`, `origin: detected`; self-managed may send none.
    - Current: a 429 waits `Retry-After`, else `RateLimit-Reset`, else a minute.
    - If passes: throttle from the headers. If fails: throttle from 429 and `Retry-After` only, and drop the detected figure.

## Gitea / Forgejo (built on a simulator, not verified on a real account)

The adapter (`api/providers/gitea/`) and its simulator were written from the official API documentation (swagger of Gitea 1.22 and Forgejo 7), never run against a server. The registry holds it as `experimental`. Each assumption below is checked on a real account (a Gitea 1.22+ and a Forgejo 7+, read-only token first: `JIRA_READ_ONLY=1` stays on), and stays open until it is; the simulator's trap that models it is named. Capabilities and traits are the catalogue's, unchanged.

- **Search of assigned issues.** `GET /repos/issues/search?assigned=true&type=issues&state=all&since=…&limit=50&page=n`.
  - Current: lists the issues assigned to the token's user in every repository they can see (closed ones too, pull requests left out by `type=issues` and again by the `pull_request` field); `since` filters on the update time; the order says nothing about updates (newest created first), so a pass reads every page.
  - If passes: kept. If fails: the feed reads each repository from `/user/repos` with `/repos/{o}/{r}/issues?assigned_by=…&since=`, as the GitHub adapter does for watched repositories.
- **Page ceiling and Link headers.** Simulator traps: a `limit` cut to the server's ceiling; Link built from `ROOT_URL`.
  - Current: `limit=50`, pages followed by the Link header's `next` (its host replaced by the connection's, only the part after `/api/v1` kept), never by counting; `X-Total-Count` read for the text search's "complete".
  - If passes: kept. If fails (a ceiling under 50 with no Link, `X-Total-Count` absent): pages follow "a page shorter than asked is the last", with a total from the header when there.
- **`since` format.** Simulator trap: a raw `+02:00` in a query string becomes a space and is refused (422); timestamps come back with the server's own offset.
  - Current: `since` always sent as UTC with `Z`, no milliseconds; every date read with its offset (instants, so the user's zone and the server's don't matter).
  - If passes: kept. If fails (`Z` refused or only a date accepted): `since` as a unix-day date, the overlap widened to a day.
- **The user's tracked times.** `GET /user/times?since=…` with the `issue` object (and its `repository`) embedded.
  - Current: the feed window is the last 31 days (30 declared, a day for the zone), re-read every pass, a removal never reported (the engine's reconciliation finds it); an entry's issue comes from the embedded `issue`, else only its `issue_id`.
  - If passes: kept. If fails (no embedded issue on this version, or `since` ignored): entries are read per issue from the assigned list (`…/issues/{n}/times`), and the declared window narrows to what that covers.
- **Adding time.** `POST /repos/{o}/{r}/issues/{n}/times` with `{ time, created }`.
  - Current: `time` in whole seconds, `created` (UTC) honoured for an ordinary user and kept as the entry's start, 200 with the entry; the note is not kept (tracked time has none), so the entry's comment reads back empty.
  - If passes: kept. If fails (`created` ignored unless admin): an entry would always start "now", so the declared `session` shape is wrong; time writing is switched off (`write: none`) until the shape is redeclared.
- **Who sees and deletes what; time tracking off.** Simulator traps: 400 `time tracking disabled`; an empty 403 without permission; 404 for an entry already gone; others' entries listed for writers.
  - Current: list returns everyone's entries to a writer (marked editable only when the user's own), delete of another's is `forbidden`, delete of a missing entry a success, `time tracking disabled` is `forbidden`.
  - If passes: kept. If fails (404 for a switched-off repository, or non-writers listing others'): the mapping follows the real status and message.
- **Edit answers.** Simulator trap: `PATCH …/issues/{n}` answers 201 with the issue; subscriptions 200 or 201, empty body.
  - Current: any 2xx is a success; the issue is read from the edit's answer.
  - If passes: kept. If fails (empty body on edit): the engine reads the issue again (`apply` returns null).
- **Renamed repositories.** Simulator trap: the old name redirects (301 for reads, 307 for writes) and the key changes while the issue's global `id` stays.
  - Current: redirects followed by the shared fetch (same origin, Authorization kept); `remoteId` is the global id, the container is the repository id with its full name as key.
  - If passes: kept. If fails (404, or a redirect to the web UI): an old key is `missing` until reconciliation; the engine treats the new key through the id alias.
- **Subscriptions.** `PUT/DELETE …/issues/{n}/subscriptions/{login}`.
  - Current: the login comes from `GET /user`; subscribing twice or leaving twice is a success.
  - If passes: kept. If fails (a different path or a 4xx for "already"): `watch` maps that answer to success.
- **Timeline as history.** `GET …/issues/{n}/timeline`.
  - Current: `close`, `reopen`, `change_title`, `label` (body `"1"` when added), `milestone`, `assignees` (`removed_assignee`) become changes; other types are skipped.
  - If passes: kept. If fails (other field names): the mapping is adjusted; `history` can be declared off until then.
- **Token scopes.** Simulator trap: 403 naming the missing scope; 401 for an unknown token.
  - Current: a personal access token with `read:user`, `read:issue`, `write:issue` (and `read:repository` for the repository lists to come) is enough; a missing scope is `forbidden`, not `auth`.
  - If passes: kept, documented in `docs/providers/gitea.md`. If fails (more scopes needed, `repository` for reads): the document and the connection form are corrected.
- **Workflow beyond open/closed.** Current: only the `boolean` source is active; scoped labels (`scope/item`, `exclusive`) need the connection's mapping to get categories, and project boards have no REST endpoint known to the adapter. Both stay declared in the catalogue, inactive.
  - If passes (project boards in the API, or a mapping UI for scoped labels): add the `column` / `labelSet` active sources and their statuses.
  - If fails: they stay declared and inactive; transitions stay open/closed.
- **No rate limit.** Current: Gitea sends no rate-limit headers and the probe declares no budget; a proxy's 429 / `Retry-After` and a 403 with spent `X-RateLimit-*` are waits.
  - If passes: kept. If fails (headers on some servers): the probe reads them as `detected`.
- **Webhooks.** `X-Gitea-Signature` (hex HMAC-SHA256 of the body, no prefix), `X-Gitea-Delivery`, `X-Gitea-Event`; Forgejo's `X-Forgejo-*` twins.
  - Current: `api/providers/gitea/webhook.ts` verifies the signature in constant time and reads the delivery id and event; `issues`, `issue_label`, `issue_assign`, `issue_milestone` are signals for `issueChanged`, `issue_comment` for `commentAdded`; `sentAt` is the changed object's update time. The provider contract has no webhook operation yet, so nothing calls it. Declared `signal` only.
  - If passes: kept (a `webhook-gitea-<event>` row before any event is promoted to `full`). If fails (another header, or a `sha256=` prefix on a version): the reader accepts it.
- **Deleted users and empty lists.** Simulator traps: `assignees: null` when nobody is assigned; a deleted account's writings are by `Ghost` (id -1).
  - Current: null read as none; Ghost is a person like another.
  - If passes: kept. If fails: the mapping follows the real shapes.
- **Forgejo.** Current: the same API and the same paths; version strings like `7.0.0+gitea-1.22.0`. If it differs (tracked time, scoped labels, timeline types), the difference is recorded here and handled by version in the adapter.


## Linear (built on a simulator, not verified on a real account)

The Linear adapter (`api/providers/linear/`) and its simulator were written from Linear's public GraphQL documentation, with no call to a real workspace. Each assumption below is held as **Current** until a read-only run on a real account (personal API key; queries first, mutations only on a scratch team) shows it. The adapter is registered `experimental` until they pass. All stay open.

1. **Personal key header.** A personal API key goes in `Authorization` as is, an OAuth token as `Bearer`.
   - Current: key as is; `Bearer lin_api_…` modelled as refused (401).
   - If passes: nothing changes.
   - If fails: send Bearer for both, drop the `oauth` flag in `client.ts`.
2. **Rate-limit shape.** A spent budget answers HTTP 400 with `extensions.code = RATELIMITED` (not always 429); `X-RateLimit-Requests-*` and `X-RateLimit-Complexity-*` reset values are UTC epoch seconds.
   - Current: 400 or 429 both read as `rateLimit`; reset in seconds (milliseconds tolerated); the exhausted budget sets the wait.
   - If passes: nothing changes.
   - If fails: fix `rateLimitOf` (unit, header names); re-record the figure.
3. **Complexity cap.** A query over 10,000 points is refused; an issue with its nested fragment weighs about 45 points.
   - Current: 50 issues per page in feeds, 100 at most in searches, `labels(first: 20)`.
   - If passes: page sizes can grow towards the cap, measured from `X-Complexity`.
   - If fails: smaller pages or fewer nested fields.
4. **Feed ordering and cursors.** `issues(orderBy: updatedAt)` lists newest first only, with keyset cursors that survive edits meanwhile; `filter.updatedAt.gte` is inclusive.
   - Current: a pass reads newest first; its checkpoint is the pass start less 60 s, so an issue touched mid-pass is read by the next pass.
   - If passes: nothing changes.
   - If fails: widen the overlap, or read by `createdAt` plus a second pass.
5. **Filters.** `assignee: { isMe: { eq: true } }` and `subscribers: { some: { isMe: { eq: true } } }` exist on `IssueFilter`; `includeArchived: true` includes trashed issues, flagged `trashed`.
   - Current: feed by assignee; departures by subscription.
   - If passes: nothing changes.
   - If fails: another filter for departures, or declare `gone.movedOut: false` in the catalogue and leave it to reconciliation.
6. **Departures.** A user unassigned from an issue stays subscribed to it, so the departures pass sees it (reported `movedOut`); a trashed issue they followed is `deleted`.
   - Current: as written; the catalogue keeps `deleted` and `movedOut` true.
   - If passes: keep.
   - If fails: the pass finds nothing; reconciliation does, and the catalogue value is revisited.
7. **Moves between teams.** The issue keeps its id and gets a new identifier; `issue(id: "<old identifier>")` still resolves to it.
   - Current: found under its new key, so the engine aliases the old one.
   - If passes: nothing changes.
   - If fails: an old key is `none`; the engine finds the issue by id only.
8. **Missing issues.** `issue(id:)` for an unknown id or identifier answers HTTP 200 with an "Entity not found" error (and no 404).
   - Current: read as `notFound`; null from `getIssue`, `none` from `findIssue`.
   - If passes: nothing changes.
   - If fails: map the real error type or code in `refused`.
9. **Mutation outcomes.** A mutation on a trashed issue answers `success: false` with HTTP 200, and moving to another team's state is a validation error.
   - Current: both are `invalid`.
   - If passes: nothing changes.
   - If fails: refine the kinds (`conflict` for a trashed issue).
10. **States.** Any state of the issue's team can be set (`stateId`); state `type` is always one of triage, backlog, unstarted, started, completed, canceled; triage states only exist on teams with triage on.
    - Current: transitions are every other state of the team, categories by type.
    - If passes: nothing changes.
    - If fails: transitions limited to what the real API lists.
11. **Dates.** `dueDate` is a date without a zone; `createdAt`/`updatedAt` and the `startedAt`/`completedAt`/`canceledAt` stamps are UTC, and the stamp of the state the issue is in is when it entered it (cleared on reopen).
    - Current: due kept as the day it says; `statusChangedAt` from the stamp of its state type.
    - If passes: nothing changes.
    - If fails: `statusChangedAt` null, or read from history.
12. **Priority and estimate.** Priority 0 is "No priority"; estimates are points on a per-team scale, never time.
    - Current: 0 is null, 1–4 ranked 0, 1, 3, 4; estimate kept in `fields.estimate`, `estimateSeconds` null.
    - If passes: nothing changes.
    - If fails: adjust the scale.
13. **Comments and history.** An integration's comment has `user: null` and a `botActor`; `issue.history` lists newest first with `fromState/toState`, `fromAssignee/toAssignee`, `fromPriority/toPriority`, `fromTitle/toTitle`, `fromEstimate/toEstimate`, `fromDueDate/toDueDate`, `addedLabels/removedLabels`.
    - Current: as written; history sorted oldest first by the adapter.
    - If passes: nothing changes.
    - If fails: fix the field names in `toChanges`.
14. **Search.** `searchIssues(term:)` is top-level and searches the whole workspace, not only the user's issues.
    - Current: used as is.
    - If passes: nothing changes.
    - If fails: filter client side to the user's issues.
15. **Webhooks.** `Linear-Signature` is the hex HMAC-SHA256 of the raw body under the webhook's signing secret, `Linear-Delivery` is the delivery id, and the body's `webhookTimestamp` (epoch ms) is the send time, refused when more than 60 s off.
    - Current: `linearWebhook.verify/deliveryId/sentAt` in `adapter.ts`, not yet wired (webhooks are the last provider work); payloads stay `signal`.
    - If passes: wire it to the webhook route; promote events to `full` only when a payload is shown to carry everything.
    - If fails: fix the header names, the digest encoding or the window.
16. **Team membership.** `viewer.teams` lists the teams the user belongs to; a user in none has no active source and falls back to a single workspace-level `itemState` source.
    - Current: as written.
    - If passes: nothing changes.
    - If fails: read `teams` and filter by `members`.


## YouTrack (built on a simulator, not verified on a real account)

The YouTrack adapter (`api/providers/youtrack/`, status `experimental`) was written from YouTrack's REST documentation and run only against `youtrackSimulator()`. Nothing below has been seen on a real instance. Each assumption is open: **Current** is what the adapter does until it is checked, **If passes** what is kept or promoted, **If fails** what changes. Cloud (`*.youtrack.cloud`) and a self-hosted instance should both be tried; any difference is itself a result.

| Id | Current | If it passes | If it fails |
| --- | --- | --- | --- |
| youtrack-auth | `Authorization: Bearer perm:...` (permanent token) on every call; `GET /api/users/me?fields=id,login,name,fullName,email,avatarUrl,guest`; a `guest` answer is an `auth` error | as is | the header or the guest signal changes in `client.ts` / `verify` |
| youtrack-fields-paging | Every call names its `fields`; lists use `$top=100` and `$skip` by what came back, ending on an empty page; no Link header | as is | page by whatever the real list endpoints give (cursor); `allPages` and `pass` change |
| youtrack-page-cap | The server may cut a page below `$top`; a pass re-reads the last 4 positions (`TAIL`) so an item changing mid-pass cannot slip through | as is; `TAIL` tuned from the real cap | a real cap below 5 makes a pass fail as `incompatible`; the overlap becomes id-based |
| youtrack-query-dates | `for: me updated: <date> .. * sort by: updated asc`, the date moved back 36 h because a query date is a day in the requesting user's zone; the exact cut is on the issue's `updated` (ms) | as is | if dates are UTC or carry a time, the margin shrinks; if `updated` has no ms precision the overlap grows |
| youtrack-keys | Keys are `PROJ-12` upper-cased; any case answers on `/api/issues/{key}`; the internal id (`2-45`) is the `remoteId` and survives a move; the old key still answers after a move | as is | lookups by lower case or old key fall back to a search; a move becomes a `transferred` gone |
| youtrack-hidden | An issue in a project the token cannot read is a 404 (never 403) and is simply absent from lists | as is | map the real answer: `lostAccess` could be reported |
| youtrack-state-field | The State field is found by `$type` (`StateIssueCustomField`, `StateMachineIssueCustomField`), not by name (localized); its project bundle values come with the issue (`projectCustomField.bundle.values`) | as is | read the bundle through `/api/admin/projects/{id}/customFields` per project |
| youtrack-state-categories | `isResolved` is `done`, or `cancelled` for names like Won't fix, Duplicate, Obsolete; unresolved is `doing` for names like In Progress, In corso, else `todo`; origin `native`; no `triage` or `backlog` | keep; the connection's own mapping may still override | move the name heuristics to the connection's mapping (`by: "mapping"`) and leave only `done`/`todo` native |
| youtrack-transitions | Plain State: the allowed list is the project's bundle values (id `state:<name>`), applied with `POST /api/issues/{id}` and a `customFields` entry; a workflow that refuses answers 400 with `error_description` (`invalid`) | as is | read the allowed values another way, or treat a refusal as a `conflict` |
| youtrack-state-machine | State machine fields: `possibleEvents` listed (id `event:<id>`), the event sent as `{ name, $type, event: { id } }`; the destination of an event is not given, the event's name stands for it | as is | the `to` status stays unknown for events: transitions offered with the issue's current status, and the engine reads the issue again |
| youtrack-fields-names | Priority, Type, Assignee(s), Estimation, Spent time, Due Date are read by their default English names and field types; a renamed or localized field is not mapped | as is | map them by the project's field ids, read once per project |
| youtrack-due-date | A Due Date value is a timestamp read as a UTC date | as is | read it in the user's zone (a day off for some zones) |
| youtrack-comments | Comment `text` is Markdown, taken as CommonMark; deleted comments are listed with `deleted: true` and skipped; a comment is created with `POST /api/issues/{id}/comments` `{ text }`, no idempotency key | as is | formats beyond CommonMark (YouTrack's own Markdown extensions, older wiki-format comments) are declared and converted by the core |
| youtrack-watch | Starring is watching: `POST /api/issues/{id}` with `{ watchers: { hasStar } }` | as is | use the documented watchers endpoint, or turn `watch` off in the capabilities |
| youtrack-history | `GET /api/issues/{id}/activities?categories=CustomFieldCategory,SummaryCategory,DescriptionCategory,TagsCategory,ProjectCategory,LinksCategory` (the parameter is required); `added`/`removed` are read as arrays of values | as is | other categories or value shapes are mapped; unreadable values stay as text |
| youtrack-workitem-date | A work item's `date` is the day at 00:00 UTC: written as such, read as its UTC date (no shift in any zone) | as is | read and write the day in the user's zone, or at noon UTC |
| youtrack-workitem-minutes | `duration.minutes` is the only unit: seconds are rounded to the nearest minute, at least 1 (a sub-minute entry is stored longer) | as is | the capabilities get an `increment` limit (60 s, nearest) so the core rounds before calling |
| youtrack-workitem-feed | `GET /api/workItems?author=<id>&updatedStart=<ms>` is a change filter: an edited item appears, a deleted one does not (`removals: false`, found by period reconciliation) | `feed` stays incremental | the feed becomes a window by entry date (as Plane), re-read each pass |
| youtrack-workitem-types | Work types (activities) are per project: `GET /api/admin/projects/{id}/timeTrackingSettings`; the connection's whole catalogue is `GET /api/admin/timeTrackingSettings/workItemTypes`; a work type is optional (`required: "no"`) | as is | a project with a required type: the probe narrows `required` for it |
| youtrack-onbehalf | A work item for someone else: `author: { id }` in the body; refused with 403 without the permission; their entries are not editable here | as is | `onBehalf` write narrowed by the probe where the permission is missing |
| youtrack-rate-limit | A 429 with `Retry-After` (seconds or date) is a wait, 30 s when absent; no budget is declared | `typicalRateLimit` with the real figure | read the real headers; a fixed internal limit |
| youtrack-webhook | No signed webhooks: the user adds a workflow rule (or an app) that POSTs a JSON signal with a shared secret in `X-Inkledger-Secret` (and optionally `X-Inkledger-Delivery`); the secret is compared in constant time, the delivery id is the header or a hash of the body; events stay `signal` | as is; per event rows `webhook-youtrack-<event>` before any `full` | another way to authenticate (a secret in the URL path, an allow-list of the server's address) |
| youtrack-network | Every call goes through `safeFetch` against the connection's API base (a self-hosted server may be private; the shared `safeFetch` has no public/private switch yet, so the connection layer's URL check decides); the base is taken with or without `/api` and with a context path (`/youtrack`) | as is | the base handling in `apiRootOf`/`webBaseOf` changes |


## Azure DevOps (built on a simulator, not verified on a real account)

The adapter (`api/providers/azure/`, status `experimental`) was written from the REST documentation (api-version 7.1) and run only against `azureSimulator()`, which models the documented traps. Nothing below has touched a real organization. Every assumption stays open until it is checked on a real Azure DevOps Services organization (and, where it differs, an Azure DevOps Server); each keeps the conservative value shown in **Current**. When one runs, its row moves above as a concluded entry (date, API version, plan, method, anonymized responses, decision, commit).

| Assumption to check | Current | If it passes | If it fails |
| --- | --- | --- | --- |
| **Token**: a PAT with Work Items (Read & write) and Project and Team (Read) is enough; `GET /_apis/connectionData?api-version=7.1-preview` answers for it, and `authenticatedUser.id` equals the `id` of `System.AssignedTo` identities | verify and probe call `connectionData`; assignees are matched by that id | the docs name exactly those two scopes | name the scope that is missing; fall back to `uniqueName` for matching |
| **Refused token**: an invalid or expired PAT answers 401 with `X-TFS-FedAuthRedirect: Suppress` (and a 203 sign-in page without it); a PAT without the scope answers 401 or 403 | 401, 203 and an HTML body are all `auth`; 403 is `forbidden` | as modelled | map the observed status; tell scope from expiry if the message allows |
| **WIQL time precision**: `timePrecision=true` on the POST makes `[System.ChangedDate] >= '…Z'` compare the instant, not the day; a literal with a Z is UTC; the answer carries `asOf` | listChanged sends `timePrecision=true` and Z literals; the pass window ends at `asOf`, else the client clock | incremental passes are exact | read with a day of overlap and drop what is older than the checkpoint |
| **WIQL ceiling**: more than 20,000 results is an error unless `$top` is given, and `$top` cuts silently | the adapter always sends `$top` (option `wiqlTop`, 20,000), and an answer as long as `$top` is treated as cut: the checkpoint stops at the last change read | as modelled | page by a `ChangedDate` window instead |
| **Batch read**: `POST /_apis/wit/workitemsbatch` takes 200 ids, `fields` (never with `$expand`) and `errorPolicy: "Omit"` returns `null` for deleted or unreadable ids | lists read 100 per page; the caller's order is restored | as modelled | read one by one with `GET /workitems/{id}` |
| **Identities** arrive as objects (`displayName`, `id`, `uniqueName`, `_links.avatar.href`) on Services, as `"Name <unique name>"` on older Servers | both are read; the text form gives the unique name as the person's id | as modelled | a lookup of the unique name to the identity id |
| **State categories**: `GET /{project}/_apis/wit/workitemtypes/{type}/states` returns `category` (Proposed, InProgress, Resolved, Completed, Removed) | Proposed todo, InProgress and Resolved doing, Completed done, Removed cancelled; a state not in the list is todo | as modelled | a user mapping per connection (the category stays the user's) |
| **Allowed transitions**: `GET /{project}/_apis/wit/workitemtypes/{type}` returns `transitions` (state to list of `to`); an inherited process returns none and allows any state | none listed at all means any other state is offered | as modelled | offer only what a trial change accepts, or only the service's own page (`remoteUrl`) |
| **Transition fields**: moving to some states asks for fields (Resolved reason, remaining work…) | `requirements` is empty; a refusal is `invalid` with the service's message | read them from the rules or the form and fill `requirements` | stays |
| **Completed Work**: hours as a decimal, writable with JSON Patch `add /fields/Microsoft.VSTS.Scheduling.CompletedWork` on Task and Bug (not on every type), under `test /rev` | counter in seconds, rounded from hours; a type without the field is `invalid` | as modelled | read-only counter, or a per-type setting |
| **Revision test**: a failed `test /rev` is refused as a plain 400 with TF26071 (the adapter also takes 409 and 412), and a comment, a title edit or any other change is a new revision | all of these are `conflict` | as modelled | map the observed status and message |
| **Comments**: `7.1-preview.4` on `/{project}/_apis/wit/workItems/{id}/comments`, `order=asc`, `$top`/`continuationToken`, text stored as HTML; the project in the path must be the current one | comments are written as escaped paragraphs and reported as approximated until the RichText layer converts; a 404 re-reads the item's project once | as modelled; the markdown `format` of the newer API may replace HTML | stays HTML |
| **History**: `GET /_apis/wit/workItems/{id}/updates` returns `fields` with `oldValue` and `newValue`, identities as objects, plus bookkeeping fields | bookkeeping fields (Rev, ChangedDate, Watermark…) dropped; field names from the reference name | as modelled | diff the `revisions` instead |
| **Deleted items**: a deleted item answers 404 on every read; `GET /_apis/wit/reporting/workitemrevisions?includeDeleted=true&includeLatestOnly=true&startDateTime=` marks it `isDeleted` | an incremental pass lists the deleted ids since the checkpoint; a forbidden or failing feed means none (reconciliation finds them) | gone `deleted` is reliable | gone `deleted` off in the catalogue (found as `missing`) |
| **Due date**: stored as a date-time at midnight of the user's profile zone | read back in the connection's zone | as modelled | read in UTC, or ask the profile's zone |
| **Tags** are one text separated by `; `; project names can hold spaces and are the key's first part (`Back Office#4`) | split on `;`; the key pattern allows spaces | as modelled | key by the project's id |
| **Rate limits**: a 429 carries `Retry-After` and `X-RateLimit-*` headers; calls near the limit are only delayed (`X-RateLimit-Delay`), not refused | 429 is `rateLimit` with the wait; no budget figure is published; delays are not read | throttle from the headers too | stays |
| **Azure DevOps Server**: which api-version the supported releases take (7.1 may not exist; 7.0 or 6.0 may be needed), the `/tfs/{collection}` path, identities as text; a private address needs the shared fetch's private-network class (not in `safeFetch` yet) | one version (7.1) for both | a version option per connection | version per deployment |
| **Service hooks** (webhooks): the Web Hooks consumer sends the subscription's basic auth; `id` is the event id, `notificationId` counts deliveries; `workitem.updated` names the item in `resource.workItemId`, `.deleted` and `.created` in `resource.id`; `createdDate` is the send time | declared as signals; `azureWebhook` (verify, deliveryId, sentAt, event) is ready for the engine | promote events to `full` per event (`webhook-azure-<event>` rows) | stays signals |

## Shortcut (built on a simulator, not verified on a real account)

The Shortcut adapter (`api/providers/shortcut/`, status `experimental`) was written from Shortcut's REST API v3 documentation and run only against `shortcutSimulator()`. Nothing below has been seen on a real workspace. Each assumption is open: **Current** is what the adapter does until it is checked, **If passes** what is kept or promoted, **If fails** what changes. A read-only token first (`JIRA_READ_ONLY=1` stays on). Capabilities and traits are the catalogue's, unchanged.

1. **Auth and base.** `Shortcut-Token: <token>` on every call (no Bearer); base `https://api.app.shortcut.com` with `/api/v3` added; `GET /member` answers `id`, `name` and `mention_name` at the top level, `GET /members` has them in `profile` (with `email_address` and `display_icon`).
   - Current: `verify` reads `/member` and adds email and picture from `/members` when the token may list members.
   - If passes: nothing changes.
   - If fails: the header or the member shapes are corrected in `client.ts` and `verify`; if `/member` carries the email, the second call goes.
2. **Owned-stories feed.** `GET /search/stories?query=owner:<mention name>[ updated:<day>..*]&page_size=25`; archived stories only with `is:archived`; `owner:` takes the mention name, not the id.
   - Current: as written; the simulator models the operators as documented.
   - If passes: nothing changes.
   - If fails: if `owner:` wants another form (`@name`, the id) or the operator syntax differs, `feedQuery` changes; if the search cannot list a user's stories alone, the old `POST /stories/search` (owner_ids, updated_at_start, no paging, slim stories) replaces it.
3. **Search pages.** At most 25 results a page (`page_size`); the answer is `{ total, data, next }` where `next` is a path starting with `/api/v3/search/stories?` carrying the cursor; the adapter follows it as given and refuses any other.
   - Current: as written; a `next` that is a full URL of the same host is accepted too.
   - If passes: nothing changes.
   - If fails: if `next` is a bare token or another shape, `scSearch` and the page token change; if the cap is not 25 the constant moves; if search results are capped in total (a maximum number of results), a long first read must be split by day ranges.
4. **`updated:` is a UTC day.** The operator takes whole days (`2026-10-01..*`), counted in UTC; a pass asks from the UTC day of its checkpoint (less a 5-minute overlap) and cuts exactly on each story's `updated_at`.
   - Current: as written.
   - If passes: nothing changes.
   - If fails: if days are counted in the workspace's or the user's zone, the day is moved back a whole day and the exact cut keeps the result right; if `updated:` takes a time, the day granularity goes and the overlap shrinks.
5. **Search index lag and order.** A story changed a moment ago appears in the search a little later (hence the 5-minute overlap), and results come in no documented order (the adapter does not rely on one).
   - Current: overlap 5 minutes; no early stop.
   - If passes: nothing changes.
   - If fails: if the lag is longer, widen `OVERLAP_MS`; if results have a stable order, an early stop on `updated_at` is possible.
6. **Words that look like operators.** A user's search text is sent with any word containing `:`, `!`, parentheses or a leading `-`/`+` in double quotes, so it is only text; the simulator refuses an unknown `word:value`.
   - Current: quoting as written.
   - If passes: nothing changes.
   - If fails: if quotes do not neutralise operators, those characters are stripped instead; if an unknown operator is simply ignored, the quoting stays harmless.
7. **Story ids and keys.** `sc-123` is the story's public `id` (also in `app_url`: `/<workspace>/story/123/<slug>`); the id never changes, including across a move between workflows; epics have their own ids and pages.
   - Current: `remoteId` is the id as text, the key `sc-<id>`; a move changes the container and status only.
   - If passes: nothing changes.
   - If fails: if an id can change or a key needs the workspace, `parseRef` and the identity change (a gone `transferred` is not declared).
8. **Workflows and states.** `GET /workflows` lists workflows with their states; a state has `type` backlog, unstarted, started or done (no cancelled, no triage); a story names `workflow_id` and `workflow_state_id`; moving to a state of another workflow is refused (`400`); `PUT /stories/{id}` with `workflow_state_id` returns the story.
   - Current: category from the type; `done` for any done state; transitions are the other states of the story's own workflow; a missing state falls back on the story's `started`/`completed` flags.
   - If passes: nothing changes.
   - If fails: if a type exists beyond these four, `CATEGORY` gains it; if a state of another workflow is accepted (and moves the story), transitions list them too; if the refusal is not a 400, the kind mapping follows.
9. **Archived and deleted stories.** An archived story (`archived: true`) is out of the default search, found with `is:archived`, still readable by id, and reported as gone `deleted`; a hard delete is a `404` and appears in no feed.
   - Current: archived is `deleted` on an incremental pass (and returns as an item when unarchived); a hard delete is found by the webhook or by reconciliation (`getIssue` null).
   - If passes: nothing changes.
   - If fails: if archiving should not remove a story from the user's list, the archived phase goes and `gone.deleted` is declared only for what the webhook says; if a deletion feed exists, it is used.
10. **Story fields.** `deadline` is a date-time at midnight UTC (the day it says is kept as is); `estimate` is points; `updated_at` is null on a story never changed (the creation time stands in); `moved_at` is when the state last changed; `owner_ids` may hold several people; `follower_ids` replaces the whole list on `PUT`; `parent_story_id` is a sub-task's parent.
    - Current: as written.
    - If passes: nothing changes.
    - If fails: each field is read as the service gives it (a plain date, a different time field) in `toRemoteIssue`; if `follower_ids` accepts adds and removes, `watch` uses them.
11. **Members.** `GET /members` is a whole list (no paging) with `profile.name`, `profile.mention_name`, `email_address`, `display_icon.url`; deactivated members stay listed; a comment from an integration has no `author_id`.
    - Current: ids not found are shown as the id; a token that cannot list members still syncs.
    - If passes: nothing changes.
    - If fails: if the list pages or is large, it is read by id on demand; if integrations have an author, they are shown by name.
12. **Comments.** `GET /stories/{id}/comments` lists every comment including deleted ones (`deleted: true`, no text); `POST` takes `{ text }` (Markdown) and answers the comment; no idempotency key.
    - Current: deleted left out; creation is not retried without a read (idempotency `local`).
    - If passes: nothing changes.
    - If fails: if deleted comments are not listed, the filter is harmless; if `external_id` makes creation idempotent, `comments.idempotency` is promoted to `native` and the key is sent.
13. **History.** `GET /stories/{id}/history` answers entries with `changed_at`, `member_id`, `actions[].changes` (`old`/`new`, or `adds`/`removes` for owners and labels) and `references` that name states and labels.
    - Current: as written; names come from `references`, then from the workflows and members, then `#<id>`.
    - If passes: nothing changes.
    - If fails: the field names and the reference shapes in `toChanges` follow the real payload; if it pages, the adapter reads every page.
14. **Rate limit.** 200 requests a minute per token; `429` with `Retry-After` (seconds); the probe reports 12,000 an hour as typical.
    - Current: `Retry-After` or a minute; no budget headers are read.
    - If passes: nothing changes.
    - If fails: if the budget differs or has headers, the probe figure is detected from them and `refused` reads them.
15. **Webhooks.** `Payload-Signature` is the hex HMAC-SHA256 of the raw body under the webhook's secret; the body's `id` is the delivery id and `changed_at` its time; no timestamp header.
    - Current: `shortcutProvider.webhook`; payloads stay `signal` (a delivery only makes the connection read again).
    - If passes: promote events to `full` only when a payload is shown to carry everything the adapter needs, per event.
    - If fails: fix the header name, the digest encoding or where the id and time are; if there is no id or time, `deliveryId`/`sentAt` return null and the core's replay guard is the token in the URL.
16. **Workspace limits of one token.** A token belongs to one workspace; workflows are the workspace's; Teams and Projects are not read (the container is the workflow).
    - Current: the container of a story is its workflow (kind `x-workflow`).
    - If passes: nothing changes.
    - If fails: if the app needs the Team, `containers` and a `group_id` lookup are added without changing identities.

## Trello (built on a simulator, not verified on a real account)

The Trello adapter (`api/providers/trello/`, status `experimental`) and its simulator were written from Trello's public REST documentation, with no call to a real account. Each assumption below is held as **Current** until a read-only run on a real account (API key and token of a scratch Power-Up; reads first, writes only on a scratch board) shows it. All stay open.

1. **Credentials header.** The API key and token go in `Authorization: OAuth oauth_consumer_key="KEY", oauth_token="TOKEN"` (Trello also takes `key` and `token` query parameters, which would put the token in URLs and logs).
   - Current: the header on every call; the simulator accepts both forms.
   - If passes: nothing changes.
   - If fails: send them as query parameters (`client.ts`, `tr`) and make sure no log or error message prints a URL.
2. **Errors in plain text.** A bad key is 401 "invalid key", a bad token 401 "invalid token", a card or board the token can't read 401 "unauthorized card permission requested" (not 403/404), a malformed id 400 "invalid id", an unknown or deleted card 404 "The requested resource was not found."
   - Current: the first two are `auth`; "unauthorized … permission" is `forbidden` and reads as "not there" for lookups; "invalid id" and 404 read as "not there" for `getIssue`/`findIssue`.
   - If passes: nothing changes.
   - If fails: fix `refused`/`isMissing` in `client.ts` to the real texts and statuses; a lost board that answers 404 or 403 instead is `lostAccess`, which the catalogue declares false (revisit).
3. **Rate limits.** 100 calls per 10 s per token and 300 per 10 s per key, in `x-rate-limit-api-token-{interval-ms,max,remaining}` and `x-rate-limit-api-key-…` headers; over them a 429 with `API_TOKEN_LIMIT_EXCEEDED` (or the key's) and no `Retry-After`.
   - Current: the wait is the interval of the empty budget (10 s by default); the probe reports `perSecond` = max / seconds of the window, from the headers.
   - If passes: nothing changes.
   - If fails: fix header names and units in `refused` and `probe`; if the answer carries a reset time, wait for it.
4. **Member's cards.** `GET /members/me/cards` lists every card of the member in one answer (no `since`, no paging) and accepts `filter` (`visible`, `all`, …), `fields`, `members` and `member_fields`; `visible` leaves out archived cards and cards on closed boards.
   - Current: a first read uses `visible`, later ones `all` and filter on `dateLastActivity` client side, so archived cards show.
   - If passes: nothing changes.
   - If fails: another endpoint (search with `@me`, or the boards' cards) and, if the answer is too large, a paged read with a page token.
5. **Boards with lists.** `GET /members/me/boards?filter=all&lists=all&fields=name,shortLink,url,closed` returns each board with all its lists, archived ones too; `GET /boards/{id}/lists?filter=open` lists the open ones.
   - Current: lists come with the boards (one call per pass); statuses and transitions read the open lists of one board.
   - If passes: nothing changes.
   - If fails: read lists per board (`/boards/{id}/lists?filter=all`), more calls per pass.
6. **Activity stamp.** `dateLastActivity` moves for every change that matters here: list move, rename, description, due date, members, labels, archive and unarchive, comments.
   - Current: the incremental pass relies on it, with a 60 s overlap.
   - If passes: nothing changes.
   - If fails: add the member's or boards' action logs as the source of changes (as already done for deletions), or accept a periodic full read.
7. **Departures.** Deleted cards are in the board's action log as `deleteCard` (with `data.card.id`), and a member taken off a card as `removeMemberFromCard` (with `data.idMember`), both readable with `GET /boards/{id}/actions?filter=…&since=…`; an archived card is `closed: true`.
   - Current: archived and deleted are `deleted`, the user taken off is `movedOut`; a card the user is on again wins over the log; `lostAccess` and `transfer` stay off.
   - If passes: keep the catalogue values.
   - If fails: another filter or action type names; if `deleteCard` is not logged, deletion is left to reconciliation and `gone.deleted` revisited.
8. **Identity of a card.** The 24-hex `id` is stable and `shortLink` (8 characters, unique on the service) survives a move between boards, while `idShort` (the number on the board) changes; `GET /cards/{id or shortLink}` takes either. The first 8 hex characters of an id are its creation time in seconds.
   - Current: `remoteId` = id, key = shortLink, the number kept in `fields.number`, `createdAt` from the id.
   - If passes: nothing changes.
   - If fails: if a move changes the shortLink, report the old card as `transferred` (catalogue `transfer` would become `withSuccessor`) or read the key from `idShort` and the board.
9. **Dates.** `due` is an instant (UTC, with milliseconds), not a date; `start` is a date stored as an instant.
   - Current: due and start become the day they fall on in the connection's time zone.
   - If passes: nothing changes.
   - If fails: if Trello sets a due date as a day (midnight UTC), keep the UTC day.
10. **Comments.** Comments are `commentCard` actions: `GET /cards/{id}/actions?filter=commentCard&limit=100&before=<action id>` lists them newest first (default limit 50, maximum 1000), `POST /cards/{id}/actions/comments` creates one and answers the action with `memberCreator`; an edited comment keeps its action and has `data.dateLastEdited`.
    - Current: every page is read; a created comment without `memberCreator` is returned as `null` (read again); text is CommonMark; an empty text is refused.
    - If passes: nothing changes.
    - If fails: fix paging (`before` as a date instead of an id) or the shape of the answer.
11. **History.** `GET /cards/{id}/actions?filter=updateCard,addMemberToCard,removeMemberFromCard,addLabelToCard,removeLabelFromCard` carries `data.listBefore/listAfter`, `data.old.{name,desc,due,closed,dueComplete}` and `data.card`, and `member` for member actions.
    - Current: as written, one change per field, oldest first; board moves are not in the history.
    - If passes: nothing changes.
    - If fails: fix field names in `toChanges`; add `moveCardToBoard` if the card's log records it.
12. **Search.** `GET /search?query=…&modelTypes=cards&partial=true&cards_limit=N` searches cards on the member's boards (whole words unless `partial=true`), leaves archived cards out and takes at most 1000 per model type; `card_members=true` adds members.
    - Current: used as is; archived cards are also filtered out client side; `complete` is false when the limit was reached.
    - If passes: nothing changes.
    - If fails: filter more client side, or fall back to the member's cards and match titles locally.
13. **Moving a card.** `PUT /cards/{id}` with `idList` (and `pos: "bottom"`) moves it; a list on another board moves it to that board.
    - Current: transitions offer the open lists of the card's own board only; the answer is the bare card, so it is read again.
    - If passes: nothing changes.
    - If fails: adjust the body (query parameters) or `pos`.
14. **Subscribing.** `PUT /cards/{id}/subscribed` with `value` true or false; a card's `subscribed` field says whether the member watches it.
    - Current: `value` sent in a JSON body.
    - If passes: nothing changes.
    - If fails: send it as a query parameter.
15. **Webhooks.** `X-Trello-Webhook` is the base64 HMAC-SHA1 of the raw body followed by the callback URL, under the API secret of the key's app; the action's own `id` repeats on a retry and its `date` is when it happened; Trello retries a failed delivery and checks the address with a HEAD request when a webhook is created.
    - Current: `trelloWebhook.verify/deliveryId/sentAt/event` in `adapter.ts`; the contract's check reads the stored secret as `<app secret>\n<callback URL>` and refuses a secret that is only the connection's generated one. Webhooks stay unusable until the connection can hold Trello's app secret and register the webhook (`POST /webhooks`), and payloads stay `signal`.
    - If passes: wire the connection's webhook form for Trello (app secret and public address); answer HEAD with 200 on the hook route.
    - If fails: fix the signing string (some documentation shows the secret in the key's own page, not the Power-Up's) or the header name.
16. **Closed boards.** Cards on a closed board are left out of passes; a card is still readable by itself, and its lists come from `GET /boards/{id}` when the member list doesn't show the board.
    - Current: as written.
    - If passes: nothing changes.
    - If fails: read closed boards' cards too, or report them gone.

## Plane (built on a simulator, not verified on a real account)

The Plane adapter (`api/providers/plane/`, status `experimental`) was written from Plane's public API documentation (REST v1, developers.plane.so) and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real server. Each assumption below is checked on a real account (plane.so cloud, plus one self-hosted Community edition; read-only token first, `JIRA_READ_ONLY=1` stays on) before the adapter leaves `experimental`; until then **Current** holds. Capabilities and traits are the catalogue's, unchanged; `plane-worklogs` keeps its row in the table below and is repeated here as item 12.

1. **Address, auth and workspace.** Calls go to `<root>/api/v1/…` with the personal token in `X-API-Key`. The cloud's API host is `api.plane.so` and its pages are on `app.plane.so`; a self-hosted server answers and shows on one host (maybe under a path prefix). The connect form has one address field and the app's connection call stores no options, so the workspace slug is the last part of the address (`https://api.plane.so/acme`); the `workspace` option wins when set.
   - Current: as written; `GET /users/me/` needs no workspace, everything else does and says so when it is missing (`invalid`).
   - If passes: nothing changes (the connect form should ask for the workspace on its own field; the address form is the stop-gap).
   - If fails: if the cloud's web host is not `app.plane.so`, or the self-hosted API is not at `/api/v1`, change `webBaseOf` / `addressOf` (one place each).
2. **Work item paths.** Plane renamed "issues" to "work items" in its API (`/work-items/`, with `/issues/` kept deprecated). The adapter uses `/projects/<id>/work-items/…` and, across the workspace, `/work-items/<PROJ-12>/` (lookup by key) and `/work-items/search/?search=`.
   - Current: all three exist on the cloud and on current self-hosted versions.
   - If passes: nothing changes.
   - If fails: on an older self-hosted version only `/issues/` exists: switch the noun (a constant in the paths: `issuePath`, `walk`, `locate`, `searchText`) and, where no key lookup exists, find the key through the project list and `sequence_id`.
3. **Lists by cursor.** `?per_page=<≤100>&cursor=<per_page:page:offset>`; the answer has `results`, `next_cursor` (present on the last page too), `next_page_results`; the adapter follows `next_cursor` only while `next_page_results` is true.
   - Current: as written; a bare array (old servers) is read as one page.
   - If passes: nothing changes.
   - If fails: a server that omits `next_page_results` would end every list after page one; fall back to "a full page means more".
4. **No server-side filter on assignment; `order_by=-updated_at`.** The project's item list is read newest change first and filtered here (`assignees` contains the user, not deleted/archived/draft); an incremental pass stops a project's reading at the first page that ends before the checkpoint.
   - Current: `order_by=-updated_at` is honoured and `updated_at` moves on every change (state, title, assignee, comment).
   - If passes: if the list also takes an `assignees` filter, send it (the first pass shrinks from every item of every project to the user's).
   - If fails: if `order_by` is ignored, an incremental pass must read each project whole (the early stop is then wrong: remove it); if a comment or worklog does not move `updated_at`, the item is seen late (reconciliation by period finds it).
5. **`expand`.** `expand=state,assignees,labels,created_by` turns uuids into objects (`{id,name,group}`, users with `first_name/last_name/display_name/avatar`, labels with `name`).
   - Current: as written; a server that ignores `expand` is read through the project's states and the workspace's members (a test models it); labels are then left empty.
   - If passes: nothing changes.
   - If fails: other expand names or object shapes are a change in `shape` and the types in `client.ts`.
6. **Soft delete, archive, drafts.** A deleted item is a 404 and leaves every list; an archived item leaves the lists but is readable (`archived_at`); drafts are never listed; an archived project is still listed (`archived_at`) and the passes skip it.
   - Current: as written.
   - If passes: nothing changes.
   - If fails: if archived items stay in the list, the `archived_at` filter already drops them; if an archived project's items are wanted, stop skipping it in `walk`.
7. **Deletions are not seen by a pass.** `sync.gone.deleted` is declared, but a list cannot show an item that is gone: `listChanged` reports no `gone`; a delete is learned from the webhook (`issueRemoved`) or from a 404 on a read (`getIssue` is null).
   - Current: as written.
   - If passes: nothing changes.
   - If fails: if Plane offers a way to list deleted items since a time (an activity feed of the workspace), report them as `gone: deleted` in `listChanged`.
8. **Keys.** `PROJ-12` is the project's identifier and the item's `sequence_id`; sequence ids are never given again; an identifier can be renamed (the old key is then a 404 and may be taken by another project); the uuid is the identity.
   - Current: as written; a lookup by key is accepted only for the uuid asked for.
   - If passes: nothing changes.
   - If fails: if identifiers cannot be renamed, the guard is merely unused; if Plane redirects an old key, the uuid check already guards it.
9. **States and moving along them.** A state has `group` (`backlog|unstarted|started|completed|cancelled`, and `triage` for intake) mapped to the contract's categories; any state of the project can be set with `PATCH …/work-items/<id>/` `{"state": "<uuid>"}`; the PATCH answers with uuids (the item is read again); intake states are never offered.
   - Current: as written; a group the adapter does not know is `incompatible`, not guessed.
   - If passes: nothing changes.
   - If fails: if some moves are refused (a workflow with restrictions), they come back as `invalid`/`forbidden` from the PATCH; if intake can be set through the API, drop the triage filter in `transitions`.
10. **Texts are HTML.** `description_html` ("`<p></p>`" when empty) and `comment_html`; a comment is written as `<p>` paragraphs with the text escaped (anything beyond paragraphs is sent as text with a conversion warning). Comment authors (`actor`) and activity actors arrive as uuids and are named through `GET /workspaces/<slug>/members/` (a flat list of users, or memberships with a `member`).
    - Current: as written.
    - If passes: nothing changes; the RichText layer may later produce real HTML for what is now text.
    - If fails: if `actor` is already an object, `personOf` takes it; if the members list is paginated or admin-only, the author reads as the bare uuid.
11. **History** from `GET …/work-items/<id>/activities/`: `verb` (`created|updated|deleted`), `field` (null for the item's creation), `old_value`/`new_value`, `old_identifier`/`new_identifier`; lists (assignees, labels) record each addition as `created` and each removal as `deleted`.
    - Current: as written.
    - If passes: nothing changes.
    - If fails: other field or verb names are a change in `history` only.
12. **`plane-worklogs`: worklogs.** `GET/POST …/work-items/<id>/worklogs/`; `duration` is whole minutes (the adapter writes the nearest minute, at least one); the entry's day is `logged_at` (`YYYY-MM-DD`) when Plane has one, else the day it was created, counted in the connection's time zone from `created_at` (UTC); the author is `logged_by`. The catalogue says: no update, no delete, plan tier unknown.
    - Current: create and read only; `logged_at` is sent on create and read back (the field name and whether it exists are assumed).
    - If passes: if update/delete exist, update `none` → `native`, delete → true in the catalogue (and the adapter gets `update`/`delete`); keep the whole-minute rounding, declare `limits.increment` (60 s) in the catalogue so the core rounds before the adapter.
    - If fails: if there is no day on a worklog, `create` must refuse a day other than today (`invalid`) instead of sending `logged_at` (a worklog cannot be moved or deleted afterwards); if the worklogs belong to a paid plan, the first `403` on a free workspace is `forbidden` and the connection's time is read-only.
13. **`plane-worklog-feed`: the user's time.** Plane has no list of a person's time that is known to the adapter, so the window feed (30 days + 2 of overlap, by entry day) reads the worklogs of each item assigned to the user that changed within the window, one call per item.
    - Current: an item whose last change is older than the window is not read for time (a worklog on it that does not move `updated_at` is seen only through the item's own list or by reconciliation); with Plane's 60 calls a minute, a user with many recently changed items needs several minutes per feed.
    - If passes: if a worklog moves the item's `updated_at`, the limit above is only the cost; if a workspace/project-wide worklog list (or a filter by `logged_by`) exists, use it and drop the per-item reads.
    - If fails: if worklogs do not move `updated_at`, read the open assigned items too (cost: every open item, every pass).
14. **Rate limit.** 60 requests a minute per API key; every answer carries `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds); a throttled call is 429 with `Retry-After` and a `{"detail": "… Expected available in N seconds."}` body.
    - Current: the wait is `Retry-After`, else `X-RateLimit-Reset`, else the number in the text, else a minute; the probe reports a typical 3,600 an hour (the limit itself is not in a header).
    - If passes: nothing changes; detect the budget from a header if one appears.
    - If fails: another reset unit (milliseconds, a date) is a one-line change in `rateLimited`.
15. **Search.** `GET /workspaces/<slug>/work-items/search/?search=` answers `{ "issues": [{ id, name, sequence_id, project__identifier, project_id }] }` (all the workspace's items the user can see, not only theirs); each hit is read whole.
    - Current: as written; `complete` is false when there are more hits than asked for.
    - If passes: nothing changes.
    - If fails: another envelope (`results`) is already read; a different hit shape means a different way to reach the full item (by key).
16. **Access.** A project the user left answers 403 on its own paths and 404 by key; both read as "not there" for lookups (`getIssue` null, `findIssue` none) and 403 is said where an operation needs the project (`forbidden`).
    - Current: as written.
    - If passes: nothing changes.
    - If fails: if Plane answers 404 for the project paths too, the same code reads it as `notFound`.
17. **Webhooks.** `X-Plane-Signature` is the hex HMAC-SHA256 of the raw body under the webhook's secret key; `X-Plane-Delivery` is the delivery's id; `X-Plane-Event` is `issue`, `issue_comment`, `project`, `cycle`…; the body has `action` (`create|update|delete`). No timestamp is documented, so nothing is refused as stale.
    - Current: all signals (a `webhook-plane-<event>` row is added before any is declared `full`); an issue `delete` is `issueRemoved`.
    - If passes: promote nothing here; payload spikes decide.
    - If fails: another header name or encoding (a `sha256=` prefix) is a one-line change in `planeWebhook`; if the body carries a time, add `sentAt`.
18. **Links.** A work item opens at `<web>/<workspace>/browse/PROJ-12/`; older links are `<web>/<workspace>/projects/<uuid>/issues/<uuid>`; a self-hosted server may send avatars as paths on its own site (resolved against its address).
    - Current: as written; a link of another workspace or host is not recognised.
    - If passes: nothing changes.
    - If fails: an avatar that can't be resolved is shown without a picture, not an error; another link shape means another pattern in `parseRef`.
19. **Estimates and parents.** `estimate_point` is read only when it is a number (newer versions give an estimate point's uuid, which is not a value); `parent` is a uuid, so an item with a parent is a sub-item but its parent reference is not given (its key is unknown without another read).
    - Current: as written.
    - If passes: nothing changes.
    - If fails: read the estimate points of the project (`/estimate-points/`) and the parent's key when the traits' `points`/relations are used.

## Redmine (built on a simulator, not verified on a real account)

The adapter (`api/providers/redmine/`, status `experimental`) was written from Redmine's REST documentation and run only against `redmineSimulator()`, which models the traps below as documented. Nothing here has touched a real server. Each assumption stays open until it is checked on a real Redmine (a 5.x and, for the version rows, a 4.x or 6.x); **Current** holds until then. The row `redmine-time-feed` also sits in the table "Still to run" and keeps its place there.

| Id | Current | If it passes | If it fails |
| --- | --- | --- | --- |
| redmine-auth | `X-Redmine-API-Key: <key>` on every call; `GET /users/current.json` answers the account; a bad key is a 401 with an empty body; an anonymous answer is not accepted | as is | the header or the anonymous signal changes in `client.ts` / `verify` |
| redmine-json-suffix | The format is the `.json` suffix; an HTML answer (REST off, login page) is `incompatible` with a hint | as is | map the real answer (a 403 or a redirect to `/login` becomes `auth`) |
| redmine-paging | `limit=100` and `offset`, ended by `total_count` or an empty page; a server cap below 100 is followed by what came back | as is | page by whatever the real list gives; `TAIL` and the page size change |
| redmine-updated-on-filter | `updated_on=>=2026-10-14T08:30:00Z` (documented example) is inclusive and exact to the second; `sort=updated_on,id` is ascending; the checkpoint is the latest `updated_on` seen, read again a minute back | as is | if the time is ignored (day granularity), widen the overlap to a day and cut on `updated_on` client-side |
| redmine-pass-stability | An item changed during a pass moves to the end of the order and shifts the rest; each page starts 4 positions back and drops what it already gave | as is; `TAIL` tuned | a pass fails as `incompatible`; move to a window on `updated_on` instead of offsets |
| redmine-status-all | `status_id=*` lists open and closed issues (the default is open only) | as is | read `open` and `closed` separately and merge |
| redmine-assigned-me | `assigned_to_id=me` is the user only: issues assigned to the user's groups are not listed | as is | add a group filter (`assigned_to_id=<group>` for each group of the user) |
| redmine-issue-status | The issue's `status` is `{id, name}` (no `is_closed` on some versions); `is_closed` comes from `GET /issue_statuses.json`, read once per connection and again (at most every 30 s) when an issue names an unknown status | as is | read `is_closed` from the issue when the version gives it, drop the list call |
| redmine-status-categories | Closed is `done`, or `cancelled` for names like Rejected, Won't fix, Duplicate, Rifiutato; open is `doing` for names like In Progress, Resolved, Feedback, In corso, else `todo`; origin `native`; no `triage` or `backlog` | keep; the connection's own mapping may still override | move the name heuristics to the connection's mapping (`by: "mapping"`) and leave only `done`/`todo` native |
| redmine-allowed-statuses | `GET /issues/{id}.json?include=allowed_statuses` (5.0+) lists the next statuses, the current one included (dropped); older servers omit the key and nothing is offered | as is | offer every status and let the server refuse, or read `/workflows` (admin only) |
| redmine-transition-fields | A status change that needs a field (workflow "required") is a 422 `{errors:[...]}` with the message; `requirements` is empty | as is; read the required fields from the workflow when a user can | stays |
| redmine-write-204 | `PUT /issues/{id}.json` and `PUT /time_entries/{id}.json` answer 204 with no body; the adapter reads the record again; a note leaves `comment: null` | as is | read the journal added (the last one by the user) and return it |
| redmine-hidden-issue | An issue that exists but is not visible answers 403 (not 404); lookups read it as absent, operations as `forbidden`; `lostAccess` stays off | as is | map the real status; `lostAccess` could be reported |
| redmine-projects | The issue names its project by `{id, name}` only; the identifier comes from `GET /projects.json` (paged, visible projects only); an unknown (archived) project keeps its id as key; the parent project's name is the group | as is | read `/projects/{id}.json` per project |
| redmine-move | An issue keeps its id when it moves to another project (no `transferred`); only the container changes | as is | a move becomes a `gone` `transferred` with a successor |
| redmine-journals | Comments are `include=journals` entries with non-empty `notes`; journals carry no edit time (`updatedAt` null); private notes you can see are listed | as is | skip `private_notes`, or read `updated_on` where the version gives it |
| redmine-history-values | Journal `details` hold ids as text: status and project from the cached lists, priority from `/enumerations/issue_priorities.json`, tracker from `/trackers.json`, assignee from `/users/{id}.json` (a 403/404 keeps `#id`); other ids stay as written; custom field names from the issue | as is | resolve more fields (versions, categories) or keep ids only |
| redmine-comment-format | The text format is textile (the server's setting may be Markdown or CommonMark: shown as textile); a comment is written as the Markdown text unchanged (paragraphs) and the other Markdown features are reported `approximated` | as is | convert Markdown to textile in the core and widen `writePreserves`; read the server's format and declare it per connection |
| redmine-watch | `POST /issues/{id}/watchers.json {user_id}` and `DELETE /issues/{id}/watchers/{user_id}.json` answer 204 whether or not anything changed; 403 without the permission | as is | a different permission needed for self-watching: turn `watch` off in the probe |
| redmine-time-feed | `GET /time_entries.json?user_id=<id>&from=&to=` over the last 32 days (30 plus 2 of overlap) and a day ahead, `limit=100`, `offset`; entries without an issue are skipped; the default sort is newest day first | `feed` stays a window | if an `updated_on` filter works on time entries, the feed becomes incremental with no removals |
| redmine-time-issue-filter | `issue_id=<id>` also returns the entries of the issue's subtasks (and nothing guarantees which); the adapter keeps entries whose `issue.id` is the issue's | as is | trust the filter, drop the client-side check |
| redmine-hours | `hours` is decimal to two places: seconds are rounded to the nearest 36 s, shorter than 18 s is refused before the call, and what Redmine stores is read back | as is | the capabilities get an `increment` limit (36 s, nearest) so the core rounds before calling |
| redmine-spent-on | `spent_on` is a plain date written and read as is (no zone); a missing `spent_on` would be today in the user's zone, so it is always sent | as is | convert in the connection's zone |
| redmine-default-activity | An entry without `activity_id` gets the server's default; no default is a 422 `Activity cannot be blank`; `required: serviceDefault` | as is | `required` becomes `input` and the core asks for one |
| redmine-activities | A project's activities: `GET /projects/{id}.json?include=time_entry_activities` (3.4+; missing means the whole catalogue); the whole catalogue: `GET /enumerations/time_entry_activities.json`, inactive ones left out | as is | read project overrides another way, or offer the whole catalogue only |
| redmine-onbehalf | `user_id` on `POST /time_entries.json` needs "Log time for other users" (4.1+); without it Redmine ignores it and logs for the caller: the adapter compares the answer's user, deletes the wrong entry and reports `forbidden` | as is | a 403/422 is then the refusal; keep the check |
| redmine-time-permissions | Own entries are editable (`editable` true), others' not; a refused change is a 403 (`forbidden`) | as is | read the permission from the account's roles |
| redmine-comment-length | A time entry comment is at most 1024 characters; Redmine's 422 message is shown | as is | truncate or split in the core |
| redmine-spent-hours | `spent_hours` on the issue is read when present (missing without the permission to see time entries) | as is | sum the entries instead |
| redmine-rate-limit | No limit of its own; a proxy's 429 with `Retry-After` (seconds or date), else an `X-RateLimit-Reset` (epoch or seconds), else 30 s; no budget is declared | `typicalRateLimit` where a common proxy setup is known | read the real headers |
| redmine-webhook | No webhooks: a plugin or hook POSTs a JSON signal with the secret in `X-Inkledger-Secret` (and optionally `X-Inkledger-Delivery`, `timestamp`); compared in constant time; the delivery id is the header or a hash of the body; events stay `signal` | as is; a row `webhook-redmine-issueChanged` before any `full` | adopt the header scheme of the plugin that is really used (a signature, a token in the URL) |
| redmine-network | Every call goes through `safeFetch` with `network: "private"` against the connection's base (with a sub-URI); the base is the site root, no `/api` | as is | the base handling in `webBaseOf` changes |

## OpenProject (built on a simulator, not verified on a real account)

The OpenProject adapter (`api/providers/openproject/`, status `experimental`) was written from the API v3 documentation and run only against `openprojectSimulator()`, which models the traps below as documented. Nothing here has met a real server. Each assumption is open: **Current** is what the adapter does until it is checked, **If passes** what is kept or promoted, **If fails** what changes. Check OpenProject Cloud (or the community instance) and one self-hosted release (the oldest supported, 12.x, and a current one) where they differ; any difference is itself a result.

| Id | Current | If it passes | If it fails |
| --- | --- | --- | --- |
| openproject-auth | `Authorization: Basic base64("apikey:<token>")` on every call; `GET /api/v3/users/me`; a wrong token is 401 (`auth`); an `AnonymousUser` answer (or no login and the name Anonymous) is an `auth` error | as is | the header or the anonymous signal changes in `client.ts` / `verify`; an API switched off by the admin is mapped to what the server really answers |
| openproject-keys | The key is `#<id>` (also read as `WP#<id>`), the id global to the instance and unchanged by a move between projects; links read: `/work_packages/<id>`, `/projects/<p>/work_packages/<id>[/…]`, `/work_packages/details/<id>`, `/wp/<id>`, `/notifications/details/<id>`, `/api/v3/work_packages/<id>`, with a context path in front on a sub-URI install | as is | add the missing link shapes; a key with the project (`PROJ#12`) if ids prove not unique |
| openproject-feed-filter | `GET /api/v3/work_packages?filters=[{"assignee":{"operator":"=","values":["me"]}},{"updatedAt":{"operator":"<>d","values":["<ISO instant>",""]}}]&sortBy=[["id","asc"]]`: `me` is accepted as a user value, `<>d` takes full instants and an empty upper bound, and the lower bound is inclusive | as is | the open bound becomes a far-future instant, or the filter `>=d`/`>t-` is used with a day of overlap and an exact cut on `updatedAt` |
| openproject-default-filter | A list asked with no `filters` keeps only the open work packages; any `filters` removes that default, so closed ones come with `assignee`/`updatedAt` alone | as is | add `{"status":{"operator":"*","values":null}}` ("all") to every list |
| openproject-paging | `pageSize=100&offset=<page>`: `offset` is a page number from 1; the answer's `pageSize` (cut to the server's cap) and `total` decide the end; a pass is read in id order so a work package edited meanwhile keeps its place | as is | page by whatever the real parameters mean; a deletion during a pass can still shift the rest by one (the next pass finds the one skipped) |
| openproject-embedded | List elements embed `project` (with `identifier`), `status` (with `isClosed`), `type`, `priority`, `author`, `assignee`; when absent the links' titles are used, the project key is its id, and statuses are read once from `/api/v3/statuses` | as is | read the project identifier and statuses from their own endpoints, once per pass |
| openproject-state-categories | `isClosed` is `done`, or `cancelled` for names like Rejected, Duplicate, Obsolete, Scartato; open is `doing` for names like In progress, Developed, In testing, In corso, else `todo`; origin `native`; no `triage` or `backlog` | keep; the connection's own mapping may still override | move the name heuristics to the connection's mapping (`by: "mapping"`) and leave only `done`/`todo` native |
| openproject-transitions | `POST /api/v3/work_packages/<id>/form` with `{}` shows `_embedded.schema.status` with `allowedValues` (resources) or `_links.allowedValues` (a list of links with titles, then `isClosed` comes from `/api/v3/statuses`), the current status among them; applied with `PATCH /api/v3/work_packages/<id>` `{ lockVersion, _links: { status: { href } } }` | as is | read the allowed statuses another way (the work package's `_links`, or a trial change), or treat the form as unavailable and offer only the service's own page (`remoteUrl`) |
| openproject-lockversion-wp | A change reads the work package first and sends its `lockVersion`; a stale one is 409 (`conflict`), a missing one 422 (`invalid`); the form's POST is a read and allowed on a read-only server | as is | map the observed status for the stale and missing cases |
| openproject-transition-fields | `requirements` is empty; a status that needs a field (a custom field required by the type, a mandatory comment) is refused 422 and shown as `invalid` with the attribute in `fields` | read the form's `validationErrors` and schema to fill `requirements` | stays |
| openproject-text | Descriptions and comments are `format: "markdown"` (OpenProject 8+), read as CommonMark from `raw`; `textile` (older) is passed as textile; an activity with a non-empty `comment.raw` that is not `Activity::Revision` is a comment; a comment is created by `POST /work_packages/<id>/activities` `{ comment: { raw } }`, no idempotency key | as is | formats beyond CommonMark (OpenProject's own Markdown extensions, macros, work package links `#12`) are declared and converted by the core; internal comments (newer releases) are filtered by the server or need a flag |
| openproject-history | `GET /work_packages/<id>/activities` mixes comments, changes and revisions; each `details[].html` is a sentence in the user's language, read apart only as English ("X changed from A to B", "X set to B", "X deleted (A)"), otherwise kept whole with the field "Change" | as is | find a structured source (a journal's `data`, or `?select=`) or drop the field/from/to split |
| openproject-watch | Watching is `POST /work_packages/<id>/watchers` `{ user: { href } }` (a second add answers 200), unwatching `DELETE /work_packages/<id>/watchers/<user id>` (404 when not watching is a success) | as is | use the documented status codes; `watch` off in the capabilities if self-watching needs a permission most users lack |
| openproject-search | Text search is the filter `{"subjectOrId":{"operator":"**","values":["<text>"]}}` sorted by `updatedAt desc`, `pageSize = limit + 1` | as is | the operator or filter name changes in `searchText` (`subject` with `~`, or the global search) |
| openproject-duration | `estimatedTime`, `spentTime` and a time entry's `hours` are ISO 8601 durations (`PT1H30M`, fractions of an hour allowed); read into whole seconds, a day counted as 24 hours; written as `PT<h>H<m>M<s>S` | as is | a unit the server rounds (hours kept to 2 decimals, or whole minutes) gets an `increment` limit in the capabilities |
| openproject-spent-time | `spentTime` is present only with the right to see time entries and the module on; otherwise `spentSeconds` is null | as is | read the sum from the time entries instead |
| openproject-entries-model | A time entry has `spentOn` (a plain date), `hours`, `comment` (≤ 255 characters, plain), `_links.workPackage/user/activity/project`; created by `POST /api/v3/time_entries` `{ spentOn, hours, comment: { raw }, _links }`, changed by `PATCH /api/v3/time_entries/<id>`, deleted by `DELETE` (404 is a success); `_links.update` / `updateImmediately` / `delete` say what the user may do now | as is | send the project link, or the comment as a plain string; editable derived from the user and the permission instead of the links |
| openproject-entry-lockversion | The catalogue's `concurrency: "revision"`: the revision of an entry is its `lockVersion` when it carries one (sent back on a change, a stale one 409), else its `updatedAt`, compared before the write (a small race remains) | `revision` stays; if entries have a `lockVersion` the fallback is dead code | if neither is dependable: `concurrency` becomes `none` in the catalogue and the core stops requiring a version |
| openproject-entry-feed | `GET /api/v3/time_entries?filters=[{"user":{"operator":"=","values":["me"]}},{"updatedAt":{"operator":"<>d","values":["<ISO instant>",""]}}]&sortBy=[["id","asc"]]` is a change filter (`updatedAt` exists on time entries): an edited entry appears, a deleted one does not (`removals: false`, found by period reconciliation); entries on no work package (project time) are left out | `feed` stays incremental | the feed becomes a window by `spentOn` (as Plane), re-read each pass, if there is no change filter |
| openproject-entry-activities | Activities are the form's allowed values: `POST /api/v3/time_entries/form` with the work package link (per project: a project may switch some off) or `{}` (the connection's catalogue), as resources or links; a missing activity gets the instance's default (`required: "no"`); one the project doesn't allow is 422 | as is | read the global list from `/api/v3/time_entries/activities` where it exists; a project with no default makes the activity required for it (narrowed by the probe) |
| openproject-onbehalf | An entry for someone else: `_links.user` at creation, 403 without "log time for other users", 422 for an unknown user; who logged an entry is fixed (422 on change; the adapter refuses first) and their entries are shown not editable | as is | `onBehalf` write narrowed by the probe where the permission is missing |
| openproject-time-permissions | Logging needs the right in the project and the time tracking module (403 otherwise, `forbidden`); entries of others are listed only with the right to see them | as is | probe the project's permission up front (the work package's `_links` or the form) |
| openproject-dates | `spentOn`, `startDate`, `dueDate` are plain dates read as the day they say; `createdAt`/`updatedAt` are UTC instants; a date written without a time in a filter is a day in the requesting user's zone, so every filter the adapter writes is a full instant | as is | the filter's instant is read in the user's zone: the margin grows by the zone's offset |
| openproject-clock | A pass notes the local clock when it begins; the checkpoint is that instant minus five minutes (the server's clock is not ours, `updatedAt` may land late) | as is | read the server's time (the `Date` header) and drop the margin |
| openproject-rate-limit | A 429 with `Retry-After` (seconds or a date), else `X-RateLimit-Reset` (epoch seconds), else a minute, is a wait; `X-RateLimit-Remaining` is kept; no budget is declared (OpenProject's limit is off by default and set by the administrator) | `typicalRateLimit` with the real figure | read the real headers |
| openproject-webhook | A webhook with a secret signs the body: `X-OP-Signature: sha1=<hex HMAC-SHA1>`, compared in constant time; no secret means no signature and a refusal; no delivery id or send time header: the id is a hash of the body and the time the payload's `updatedAt` (`work_package`, `time_entry`) or the activity's `createdAt`; actions `work_package:created/updated`, `work_package_comment:comment`, `time_entry:created/updated`; events stay `signal` | as is; per event rows `webhook-openproject-<event>` before any `full` | another header or digest (SHA-256 on newer releases), a delivery id header if there is one, other action names |
| openproject-network | Every call goes through `safeFetch` against the connection's base (with or without `/api/v3`, with a context path); `network: "public"` for `*.openproject.com`, `"private"` for any other server (self-hosted may be on the user's network); same-origin redirects keep the credentials | as is | the base handling in `apiRootOf`/`webBaseOf` or the cloud host list in `networkOf` changes |
| openproject-versions | The oldest supported release is 12.x (Markdown, `lockVersion`, `/api/v3/time_entries` filters); older ones (Textile, no `updatedAt` filter on entries) are not supported | the floor is written in the docs | raise the floor, or add a version probe (`/api/v3/` `coreVersion`) and degrade the feed |

## Asana (built on a simulator, not verified on a real account)

The Asana adapter (`api/providers/asana/`, status `experimental`) was written from Asana's REST API 1.0 documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real account. Each assumption is checked on a real account (a free workspace and a paid one, as time tracking and search are paid) before the adapter leaves `experimental`; until then **Current** holds. `asana-status` and `asana-time-feed` also keep their rows in the table of `docs/dev/spikes.md`.

1. **Assigned-tasks feed** (`GET /tasks?assignee=me&workspace=…&opt_fields=…&limit=50`, `modified_since` on later passes, `completed_since` = 30 days on the first, `offset` from `next_page`).
   - Current: `assignee` needs `workspace`; `modified_since` is inclusive; `completed_since` keeps incomplete tasks and those completed since; a pass overlaps its checkpoint by 60 s; without `completed_since` completed tasks are returned too.
   - If passes: nothing changes.
   - If fails: if completed tasks are not returned without `completed_since`, or `modified_since` misses tasks changed by comments or time entries, read the user task list (`GET /user_task_lists/{gid}/tasks`) or search with `modified_at.after`.
2. **Nested `opt_fields`** (`assignee.photo.image_128x128`, `memberships.section.name`, `created_by.name`, `parent.name`, `workspace.name`) and the field names `html_notes`, `permalink_url`, `actual_time_minutes`, `resource_subtype`.
   - Current: all accepted; an unrequested field is absent (a compact record).
   - If passes: nothing changes.
   - If fails: drop the field (spent time, avatar) or fetch it separately; the mapping tolerates absent fields.
3. **Offset tokens**: valid only for the same query, and they expire.
   - Current: a refused offset answers 400 with "offset" in the message, read as an invalid checkpoint (the pass restarts).
   - If passes: nothing changes.
   - If fails: if the error text differs, match on the request (a 400 on a request carrying an `offset`).
4. **Task key and links**: `ASANA-<gid>`; links `/0/<project>/<task>[/f]`, `/0/0/<task>`, `/1/<workspace>/project/<project>/task/<task>`, `/1/<workspace>/task/<task>`.
   - Current: the gid never changes across project moves; `GET /tasks/{gid}` answers 404 for a deleted task and 403 for one the user cannot see (both read as not there).
   - If passes: nothing changes.
   - If fails: if a trashed task still answers 200 with `deleted: true`, report it as gone `deleted` in `listChanged`; if invisible tasks answer 404, nothing changes.
5. **Subtasks have no memberships**: the container is read from the parent's memberships (`GET /tasks/{parent}?opt_fields=memberships.project.name`).
   - Current: a subtask's `memberships` is empty; its parent's first project is its container.
   - If passes: nothing changes.
   - If fails: if subtasks carry memberships, the extra call goes away.
6. **Home project of a task in several projects**: the first membership.
   - Current: the order is stable enough to be the home; the section status is that of the first project only.
   - If passes: nothing changes.
   - If fails: pick the project by the connection's options or by workspace, and make the status source explicit per project.
7. **Due dates**: `due_on` is a day; `due_at` a UTC instant, converted to the user's day by the connection's zone.
   - Current: only one of the two is set.
   - If passes: nothing changes.
   - If fails: if both come, `due_at` wins.
8. **Sections as statuses** (`asana-status` for custom task types): `GET /projects/{gid}/sections`, `POST /sections/{gid}/addTask`.
   - Current: `addTask` to a section of a project the task is not in adds it to that project, so only the task's own project's sections are offered; categories come from the connection's `columns` option (by section name, case aside), never from names; a project with no sections gives `memberships[].section` null or an "Untitled section".
   - If passes: nothing changes.
   - If fails: if `addTask` refuses tasks outside the project, the guard is redundant; if a custom task type's status (`completion_state`) is readable and settable, add `projectField`.
9. **Comments**: stories `type: "comment"`; write `html_text`.
   - Current: `html_text` must be a `<body>`, tags limited to strong, em, u, s, code, pre, ol, ul, li, a, blockquote (no `<p>`, no headings); newlines are line breaks; the story keeps `html_text`.
   - If passes: nothing changes.
   - If fails: adjust the tag set in `toAsanaHtml`; if `<pre>` or `<blockquote>` are accepted, add `codeBlock` and `quote` to the preserved features.
10. **Time tracking entries** (`GET/POST /tasks/{gid}/time_tracking_entries`, `GET/PUT/DELETE /time_tracking_entries/{gid}`; fields `duration_minutes`, `entered_on`, `description`, `attributable_to`, `billable_status`, `approval_status`, `created_by`).
    - Current: whole minutes (a duration is rounded to the nearest, at least 1); a plain date; `billable_status` is writable (`billable` / `nonBillable`); `attributable_to` is a category gid; entries are visible to anyone who sees the task; changing an approved or submitted one, or someone else's, answers 403; deleting an unknown entry is a 404 (treated as done).
    - If passes: nothing changes.
    - If fails: if `billable_status` is derived from the category, set `billable.write` false in the catalogue; if `description` is not a field, drop the comment; if entries of others are not visible, the list only holds the user's.
11. **Time tracking categories** (`GET /time_tracking_categories?workspace=…`, an assumed endpoint) for `activities`.
    - Current: lists the workspace's categories by name.
    - If passes: nothing changes.
    - If fails: read the options of the time tracking custom field instead, or set `activities.write` false.
12. **`asana-time-feed`**: no change filter on time entries.
    - Current: feed none, reconciled by period (the adapter has no `changed`).
    - If passes: nothing changes.
    - If fails: if `GET /time_tracking_entries` filters by `modified_since` or webhooks report them, feed incremental.
13. **Search**: `GET /workspaces/{gid}/tasks/search` (paid, no paging, `limit` up to 100) and `GET /workspaces/{gid}/typeahead` (all plans, finds other people's tasks).
    - Current: 402 on a free plan, then typeahead filtered to tasks assigned to the user; "complete" is false when the result was cut at the limit.
    - If passes: nothing changes.
    - If fails: if typeahead is limited to fewer results or ignores `opt_fields`, read the tasks one by one.
14. **Rate limit**: 429 with `Retry-After` in seconds; no budget headers.
    - Current: the wait is the header's, 60 s without it; the probe gives no figure.
    - If passes: nothing changes.
    - If fails: if budget headers exist, give the probe a figure.
15. **Payment required (402)** for paid features is read as forbidden.
    - Current: 402 answers search and time tracking on free plans.
    - If passes: nothing changes.
    - If fails: if they answer 403 instead, the search fallback also catches 403.
16. **Webhooks**: handshake `X-Hook-Secret` echoed with 200; deliveries signed `X-Hook-Signature` (hex HMAC-SHA256 of the raw body); body `{ events: [{ action, resource: { gid, resource_type }, created_at }] }`; heartbeats with no events.
    - Current: events are signals (the connection is read again); no delivery id; staleness by the latest event's `created_at`.
    - If passes: nothing changes.
    - If fails: if retries of one delivery repeat the body, use a hash of it as the delivery id.
17. **Departures**: a task reassigned away, deleted or moved out of the user's list is not reported by `listChanged` (the declared reasons `deleted` and `movedOut` come from webhooks only).
    - Current: the engine reconciles ("missing"); a deleted task is a 404 on a lookup.
    - If passes: nothing changes.
    - If fails: if the task search can filter on assignee or deleted tasks appear with a flag, report them as gone.

## Todoist (built on a simulator, not verified on a real account)

The Todoist adapter (`api/providers/todoist/`, status `experimental`) and its simulator were written from Todoist's public documentation of the unified API (v1) and its Sync API, with no call to a real account. Each assumption below is held as **Current** until a read-only run on a real account (a personal API token from Settings > Integrations > Developer; reads first, writes only in a scratch project) shows it. All stay open.

1. **Base and credentials.** The API root is `https://api.todoist.com/api/v1` and a personal token goes in `Authorization: Bearer <token>`.
   - Current: `client.ts` (`td`) builds `<apiBase>/api/v1<path>` with the Bearer header on every call; the simulator refuses anything else with 401.
   - If passes: nothing changes.
   - If fails: if the personal token needs another scheme or the unified API is not reachable with it, fall back to REST v2 (`/rest/v2/…`, same Bearer header) for tasks, projects, sections and comments and keep the Sync API for the checkpoint.
2. **Who the token is.** `GET /user` answers `{ id, full_name, email, avatar_big, timezone, … }`.
   - Current: `verify` reads it; ids are strings.
   - If passes: nothing changes.
   - If fails: read the user from a Sync call (`resource_types: ["user"]`).
3. **A bad token.** The unified API answers 401; the old API answered 403 "Forbidden".
   - Current: 401 is `auth`; on `verify` a 403 is turned into `auth` too (nothing but the token can be refused there); elsewhere 403 is `forbidden` (a project the user lost).
   - If passes: nothing changes.
   - If fails: map the real status/body of an invalid token in `refused` (`client.ts`) and drop the special case in `verify`.
4. **Rate limit.** 450 requests per 15 minutes per user (fewer for full syncs), a 429 whose JSON body carries `error_extra.retry_after` in seconds; no `X-RateLimit-*` headers.
   - Current: the wait is `error_extra.retry_after`, else the `Retry-After` header, else 60 s; the probe reports `perHour: 1800` as `typical` (never `detected`, there are no headers).
   - If passes: nothing changes.
   - If fails: fix the field name in `refused`; if headers exist, read them in `probe` and report `detected`.
5. **Sync API as the changes feed.** `POST /api/v1/sync` with `{ sync_token, resource_types: ["items"] }` (JSON body): `"*"` returns every open task, the returned `sync_token` returns what changed since, completed ones with `checked: true` and deleted ones with `is_deleted: true`. The checkpoint is that token (`{ token }` inside the usual envelope).
   - Current: `tdSync`; a pass is one page; deleted tasks are reported `deleted`; completed ones are items with a `done` status. There is no clock and no overlap.
   - If passes: nothing changes.
   - If fails: if the body must be form-encoded, change `tdSync`; if a full sync is large, add paging by project; if the incremental sync does not return completed tasks, fall back to `GET /tasks/completed/by_completion_date` (at most three months a call) on top of the token.
6. **An unknown or old sync token.** Treated as a full sync (`full_sync: true`), silently.
   - Current: the adapter reads it as any pass: everything open comes back and nothing is reported gone (the engine reconciles what is missing).
   - If passes: nothing changes.
   - If fails: if it answers an error, map it to `invalidCheckpoint` so the engine starts again from `null`.
7. **Which tasks are the user's.** A task is the user's when `responsible_uid` is the user's id, or when it has no assignee and its project is not shared (`is_shared: false`); a task unassigned in a shared project is nobody's. A task reassigned to someone else simply stops coming: the catalogue declares `movedOut: false`.
   - Current: `isMine` in `adapter.ts`, with the project list (`GET /projects`) read for `is_shared`.
   - If passes: nothing changes.
   - If fails: if sync items carry the assignee under another field name (`responsible_uid` vs `assigned_to`), rename it in `client.ts`; if reassignment can be told apart reliably, declare `movedOut` and report it (changes the catalogue entry).
8. **Opaque ids and the old numeric ones.** The unified API's ids are strings (about 16 letters and digits) and the old numeric ids are refused (400); `GET /api/v1/id_mappings/tasks/<old ids>` answers `[{ old_id, new_id }]` (`new_id` null when unknown). Old links (`todoist.com/showTask?id=<number>`) carry the old id.
   - Current: the key of a task is its id; a purely numeric key goes through the mapping first (`taskBy`); a pasted `/app/task/<slug>-<id>` link is read by the part after the last hyphen; an id needs at least one digit to be taken for a key (a plain word is not).
   - If passes: nothing changes.
   - If fails: fix the mapping path or answer shape; if ids can be all letters, loosen `ID` and accept the false positives on plain words (or ask for a link).
9. **Reading one task.** `GET /api/v1/tasks/<id>` answers open tasks only (a completed one is 404); `GET /api/v1/sync/items/get?item_id=<id>` answers `{ item }` for a completed one too; a deleted one is 404 on both.
   - Current: `taskBy` asks the first, then the second; `item.is_deleted` reads as not there.
   - If passes: nothing changes.
   - If fails: if `/tasks/<id>` answers completed tasks, drop the second call; if the item read has another path or shape, fix `taskBy`.
10. **Page size and cursors.** Lists answer `{ results, next_cursor }`, `limit` defaults to 50 and is at most 200 (activities: 100); more is a 400.
    - Current: `tdAll` asks 200 a page and follows `next_cursor` (activities ask 100).
    - If passes: nothing changes.
    - If fails: fix the limits and the cursor/field names in `tdAll`.
11. **Priority.** The API's `priority` 4 is "p1" (urgent) in the app and 1 the default ("p4").
    - Current: 4, 3, 2 are P1 (urgent, rank 0), P2 (high, rank 1), P3 (medium, rank 3); 1 is no priority (`null`).
    - If passes: nothing changes.
    - If fails: flip the table in `PRIORITIES`.
12. **Due dates.** `due.date` is a day (`2026-10-30`), a floating time (`2026-10-30T09:00:00`, no zone: the user's own clock) or a fixed instant (`…Z` with `due.timezone`). The day for the user is the date itself for the first two, and the instant in the connection's zone for the third.
    - Current: `dueDay`. The raw date and zone are kept in the issue's `fields` (`dueAt`, `dueTimezone`); recurrence in `recurring`.
    - If passes: nothing changes.
    - If fails: if a fixed instant should count in the task's own zone, use `due.timezone`; if floating times arrive with an offset, handle it in `dueDay`.
13. **Sections as statuses.** Sections (`GET /sections?project_id=`) are the columns of a project; an open task in one is in that status, out of any section it is "Open", completed it is "Completed". Todoist gives sections no meaning: their category comes from the connection's `categories`, default `todo`. Moving: `POST /tasks/<id>/move` with `{ section_id }` or, out of every section, `{ project_id }`; answers 204 or the task (any 2xx is read as done and the task is read again).
    - Current: `statuses`, `transitions.list/apply`; an apply returns the task read again.
    - If passes: nothing changes.
    - If fails: if `{ project_id }` moves the task to the project's inbox or keeps its section, find the documented way to clear `section_id` and fix `apply`.
14. **Completing and reopening.** `POST /tasks/<id>/close` completes (a parent completes its sub-tasks), `POST /tasks/<id>/reopen` reopens; both 204. Closing a recurring task moves its due date on and leaves it open.
    - Current: `apply` reads the task again, so a recurring task answers "Open" with the next day; the transition `to` still says "Completed". A reopened task keeps its section.
    - If passes: nothing changes.
    - If fails: if a reopened task loses its section or a recurring task can be completed for good (`/tasks/<id>/close` with a flag), adjust the transitions offered.
15. **Comments.** `GET /comments?task_id=<id>` (paged) and `POST /comments` with `{ task_id, content }`; content is Markdown; the author is `posted_uid` and the date `posted_at`; an edit has no date of its own.
    - Current: `comments` reads and writes Markdown; names come from the project's collaborators (`GET /projects/<id>/collaborators`, `{ id, name, email }`) or `GET /user` for the user; an unknown author is shown by id.
    - If passes: nothing changes.
    - If fails: fix the field names (`item_id`/`task_id`, `posted_uid`); if comments carry an author name, use it.
16. **Activity log for history.** `GET /api/v1/activities?object_type=item&object_id=<id>` (cursor, at most 100 a page, newest first) answers `{ event_type, event_date, initiator_id, extra_data: { content, last_content, due_date, last_due_date, responsible_uid, last_responsible_uid, description, last_description } }`. The log is kept for a week on the free plan, longer on paid ones.
    - Current: `history` turns `completed`/`uncompleted` into Status changes and `updated` into one change per field present; older changes are absent on a free plan.
    - If passes: nothing changes.
    - If fails: fix the `extra_data` names; if the free plan refuses the endpoint, answer an empty history on 403.
17. **Search.** `GET /api/v1/tasks/filter?query=search: <text>` (open tasks only, cursor); the filter language treats `& | ! ( ) ,` as operators, escaped with a backslash.
    - Current: `escapeFilter` escapes those and the backslash; a search is not limited to the user's own tasks.
    - If passes: nothing changes.
    - If fails: fix the escaped set (`#`, `@`, `*`, `/` may need it too) or the path/parameter name.
18. **Webhooks.** `X-Todoist-Hmac-SHA256` is the base64 HMAC-SHA256 of the raw body under the app's **client secret**; `X-Todoist-Delivery-ID` repeats on a retry; the body has `event_name` (`item:added|updated|deleted|completed|uncompleted`, `note:added|updated|deleted`), `event_data`, `triggered_at`. Webhooks belong to an app registered in the developer console and fire for the users who authorized it: a personal token cannot register one.
    - Current: `todoistWebhook.verify/sentAt/event` and the contract's check take the stored secret as the client secret; payloads stay `signal`. Webhooks stay unusable until the connection can hold the app's client secret and an OAuth authorization; syncing is by polling.
    - If passes: wire the connection's webhook form for Todoist (client secret and the app's callback address).
    - If fails: fix the header names, the signed bytes or the time field (`triggered_at`).

## Microsoft Planner / To Do (built on a simulator, not verified on a real account)

The Planner adapter (`api/providers/planner/`, status `experimental`) was written from Microsoft Graph v1.0 documentation (the Planner resource types) and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real account. Each assumption is checked on a real work or school account with a Microsoft 365 group plan before the adapter leaves `experimental`; until then **Current** holds. Microsoft To Do (`/me/todo`, with `lastModifiedDateTime` and delta queries) is a different API and is not read. The catalogue declares no webhooks, comments, text search or remote time for planner; none of those is built.

1. **Assigned-tasks feed** (`GET /me/planner/tasks`, paged by `@odata.nextLink` carrying a `$skiptoken`).
   - Current: returns the tasks assigned to the user on every plan they can read, completed ones included, pages of up to 100 with no `$top`/`$filter`/`$orderby`; a refused skip token answers 400 with "skiptoken" in the message, read as an invalid checkpoint (the pass restarts).
   - If passes: nothing changes.
   - If fails: if `$top`/`$filter` (for example on `percentComplete`) are accepted, ask for open tasks plus recently completed ones server side; if the error text of an expired token differs, match any 400 on a request carrying `$skiptoken`.
2. **No change feed**: tasks have no `lastModifiedDateTime`; changes are told by `@odata.etag` (digest of 8 characters per task kept in the checkpoint).
   - Current: the ETag changes with every change of the task (title, bucket, percent, assignments, dates, categories, priority) and only then; the details (description, checklist, references) have their own ETag; completed tasks older than 30 days are not read.
   - If passes: nothing changes.
   - If fails: if the ETag also moves with details changes, descriptions are seen in passes (harmless); if it does not move for some task change (for example assignments), also compare a digest of the task body; if checkpoints of hundreds of tasks are too large, keep the digest in a table.
3. **Gone tasks**: a task in the last pass and not in this one is read by id.
   - Current: 404 means deleted (reported `deleted`); 403 (plan left) or 200 (unassigned) are not reported; at most 100 are checked per pass.
   - If passes: nothing changes.
   - If fails: if a deleted task answers 403 or 200 with a marker, report it from that answer; if a plan the user left answers 404 (not 403), it would be reported as deleted: then check the plan (`GET /planner/plans/{id}`) before reporting.
4. **Task key and links**: `PLANNER-<id>`; links `https://planner.cloud.microsoft/webui/plan/<plan>/view/board/task/<task>` (also with `?tid=`), `https://tasks.office.com/<tenant>/…/Home/Task/<task>` and `tasks.microsoft.com`.
   - Current: the id is 28 characters of `[A-Za-z0-9_-]`, case-sensitive, matched by `/task/<id>` at the end of the path; the task page URL the adapter builds opens the task.
   - If passes: nothing changes.
   - If fails: change the host list and path pattern in `parseRef`; if the link needs the tenant (`tid`) to open, add it from the user's profile.
5. **Status from percent complete and bucket**.
   - Current: 0 Not started, 1-99 In progress, 100 Completed (the apps only set 0, 50 and 100); a mapped bucket (by the connection's `columns`) is the status of an open task; moving a task to a bucket does not change the percent.
   - If passes: nothing changes.
   - If fails: if the apps also move the percent with the bucket, nothing to do; if "Completed" in the web app is not `percentComplete` 100, read `completedDateTime` instead.
6. **Changing a task** (`PATCH /planner/tasks/{id}` with `If-Match: <@odata.etag>` and `Prefer: return=representation`; body `percentComplete` or `bucketId`).
   - Current: without `If-Match` the answer is 428, with a stale one 412 (read as a conflict; the adapter reads the task again and tries once more); with `Prefer: return=representation` the answer is 200 with the task, else 204 (the adapter then reads the task); `percentComplete` 100 sets `completedDateTime`, 0 clears it; a bucket of another plan is 400.
   - If passes: nothing changes.
   - If fails: if a missing `If-Match` is 412, the same handling applies; if the ETag from the body is refused and the `ETag` header is needed, send that one.
7. **Due and start dates**: `dueDateTime` / `startDateTime` are UTC instants.
   - Current: the apps store a picked day as that day at 00:00:00Z, so exactly midnight UTC is read as that date; any other instant is converted to the user's day by the connection's zone.
   - If passes: nothing changes.
   - If fails: if the current apps store the local midnight in UTC (a day off for users west of UTC), read every instant in the user's zone, or in the zone of the app's setting.
8. **Plan, buckets and label names** (`GET /planner/plans/{id}`, `/buckets`, `/details` → `categoryDescriptions`): read once per plan per call.
   - Current: readable with `Tasks.Read`; a plan answering 403/404 leaves the container named by its id and the buckets unknown (the tasks read by percent); unnamed labels (null) read as their colour (`category1` Pink … `category25` DarkGray).
   - If passes: nothing changes.
   - If fails: if the colour order differs, correct `CATEGORY_COLORS`; if plan reads need `Group.Read.All`, say so in the docs and fall back to ids.
9. **Names of people** (`GET /users/{id}`): assignees and creator.
   - Current: needs `User.ReadBasic.All`; 403 or 404 leaves the id as the name; guests may not resolve.
   - If passes: nothing changes.
   - If fails: if `GET /me` is all that works, only the user's own name is known; add `/users?$filter=id in (…)` or `getByIds` for batches.
10. **Description** (`GET /planner/tasks/{id}/details` → `description`, plain text).
    - Current: a plain text, `\r\n` line ends normalized; none is an empty string.
    - If passes: nothing changes.
    - If fails: if the description comes with markup, set the body format accordingly.
11. **Plans of the user** (`GET /me/planner/plans`) for the probe's boards, read only when the options name buckets (the first 5 pages).
    - Current: the plans shared with the user, with `title`.
    - If passes: nothing changes.
    - If fails: if the list needs another endpoint (`/users/{id}/planner/plans`) or a group scope, use it; or read the plans from the tasks' `planId`.
12. **Rate limit**: 429 (and 503/504) with `Retry-After` in seconds; no budget headers.
    - Current: the wait is the header's, 30 s without it; the probe gives no figure.
    - If passes: nothing changes.
    - If fails: if Planner's own limits (per plan, per user, per tenant) answer with another header (`x-ms-throttle-*`), read it into `rateLimit` and give the probe a figure.
13. **Access token lifetime**: a pasted token expires in about an hour (`401 InvalidAuthenticationToken`, "Lifetime validation failed").
    - Current: read as `auth`: the connection asks for a new token.
    - If passes: nothing changes.
    - If fails: a long-lived token (or a refresh flow in the connection layer) is needed before real use; a refresh is not the adapter's job.
14. **Webhooks (Graph change notifications) are not declared**: `sync.webhooks` stays `null` in the catalogue.
    - Current: polling only.
    - If passes: a subscription on `/planner/tasks` (or the group) with a `clientState` (the secret) and a validation-token handshake would be wired, with `webhook.verify` comparing `clientState`, and the renewal (they expire within days).
    - If fails: stays polling.

## Wrike (built on a simulator, not verified on a real account)

The Wrike adapter (`api/providers/wrike/`, status `experimental`) was written from Wrike's API v4 documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real account. Each assumption is checked on a real account (a free or trial account, plus one with time tracking and timesheet approvals, and one in a non-default data center) before the adapter leaves `experimental`; until then **Current** holds.

1. **Assigned-tasks feed** (`GET /tasks?responsibles=["<me>"]&pageSize=100&sortField=UpdatedDate&sortOrder=Asc&fields=[…]`, `status` filter on the first pass, `updatedDate={"start":"…Z"}` on later ones and for finished tasks).
   - Current: a first pass reads `status=["Active","Deferred"]` and then `status=["Completed","Cancelled"]` updated in the last 30 days; a later pass reads everything updated since the checkpoint (less 60 s), then the recycle bin (`deleted=true`, same filter). `/tasks` without `status` returns every status; `updatedDate.start` is inclusive and to the second; a date with milliseconds is refused (400).
   - If passes: nothing changes.
   - If fails: if `/tasks` is limited to one account, loop over `/accounts/{id}/tasks`; if `responsibles` does not match co-assigned tasks, filter on `responsibleIds` client-side; if a date format is refused, adjust `wrikeInstant`.
2. **Page tokens**: `pageSize` up to 1000 and `nextPageToken`, only when `pageSize` is sent; a token is good for its own query and expires.
   - Current: a refused token answers 400 with "nextPageToken" in the message, read as an invalid checkpoint (the pass restarts).
   - If passes: nothing changes.
   - If fails: if the error text differs, treat a 400 on a request carrying `nextPageToken` as invalid checkpoint.
3. **Task ids and keys**: the API id (16 characters) is the remote id; the key is `WRIKE-<n>` with `<n>` from the `permalink` (`open.htm?id=<n>`), converted back with `GET /ids?type=ApiV2Task&ids=[n]` (answer `data: [{ id, uid }]`, unknown numbers absent).
   - Current: the permalink is a default field of a task; the number never changes; `/ids` answers an empty list for an unknown number. A key whose number Wrike does not know is "none".
   - If passes: nothing changes.
   - If fails: if `/ids` answers 404 for an unknown number, read it as "none"; if the permalink is not in the default fields, add it to `fields`; if the number changes on a move, report the new key (the remote id is the identity).
4. **Default fields**: a task answers `id, accountId, title, status, customStatusId, importance, createdDate, updatedDate, dates, scope, permalink` (and `completedDate` when completed); `parentIds`, `superTaskIds`, `responsibleIds`, `authorIds`, `effortAllocation`, `description`, `followerIds` are asked for in `fields` (a JSON list).
   - Current: as written; a single task also answers a list of one.
   - If passes: nothing changes.
   - If fails: add the field to the request, or drop what it feeds (estimate, reporter).
5. **Recycle bin**: a deleted task leaves `GET /tasks` but `GET /tasks/{id}` still answers it with `scope: "RbTask"`; `GET /tasks?deleted=true` lists it and its `updatedDate` moves.
   - Current: `RbTask` reads as not there; the later pass reports it as gone `deleted`.
   - If passes: nothing changes.
   - If fails: if `deleted=true` does not take `responsibles` or `updatedDate`, read it whole and filter; if `scope` is not returned by default, add it to `fields`; if a purged task answers 404, nothing changes.
6. **Dates**: task `dates.due` / `dates.start` are floating local times (`yyyy-MM-ddTHH:mm:ss`), instants (`createdDate`, `updatedDate`, `completedDate`) are UTC `…Z`.
   - Current: a due date is the day written, in no zone; one with a zone is converted to the user's day.
   - If passes: nothing changes.
   - If fails: if due dates come as UTC instants, convert them to the account's zone (`GET /account`) rather than the user's.
7. **Workflows and statuses** (`GET /workflows`, `customStatuses[].group`, `hidden`; `PUT /tasks/{id}` with `customStatus=<id>`).
   - Current: a task's status is a custom status of its folder's workflow; the group says its category (Active: the first of the workflow is todo, the others doing; Deferred: backlog; Completed: done; Cancelled: cancelled); a status of another workflow, or a hidden one, is refused (400); a status Wrike no longer lists reads as its group. The ways out are the other visible statuses of the workflow the task's status belongs to. Status ids are unique across workflows.
   - If passes: nothing changes.
   - If fails: if "first Active is todo" is wrong for real workflows (a workflow of only "In progress"-like statuses), make Active "doing" and let the options pick the todo status; if a task's workflow is not that of its status's owner (several parent folders with different workflows), read the workflow of the folder the task sits in.
8. **Multiple parents and no parent**: `parentIds` lists every folder the task is in (no meaningful order), none for a task in the root; folder names come from `GET /folders/{ids}`.
   - Current: the first parent is the container; a folder the user cannot read (absent from the answer) is shown by its id; no parent reads "No folder" in the account.
   - If passes: nothing changes.
   - If fails: if `/folders/{ids}` refuses the whole call for one unreadable id, fetch ids one at a time and tolerate 403; if the root needs a name, read `GET /account`.
9. **Comments** (`GET/POST /tasks/{id}/comments`, `text` HTML, `plainText=false`).
   - Current: HTML; a newline is not a break (lines are joined with `<br />`); tags outside `a b i u strike ul ol li br code` are stripped silently, so none other is sent; the answer is a list of one.
   - If passes: nothing changes.
   - If fails: if `<p>`, `<blockquote>` or `<pre>` are kept, add `quote` and `codeBlock` to the preserved features and use them; if `<strong>`/`<em>` are the stored forms, nothing changes (they are read as HTML).
10. **Following** (`PUT /tasks/{id}` with `addFollowers=["<me>"]` / `removeFollowers`).
    - Current: both are idempotent; the user's contact id is the connection's remote account id.
    - If passes: nothing changes.
    - If fails: if the parameters are named otherwise, rename them; if following needs a different endpoint, adjust `watch`.
11. **Timelogs** (`GET/POST /tasks/{id}/timelogs`, `GET/PUT/DELETE /timelogs/{id}`, `GET /timelogs?me=true&updatedDate={…}`, `GET /timelog_categories`): fields `hours`, `trackedDate`, `comment`, `categoryId`, `billingType` (`Billable`/`NonBillable`), `approvalStatus`.
    - Current: hours are decimal, kept to two decimals (the adapter rounds to 0.01 h = 36 s, at least one step) and at most 24 per entry; `trackedDate` is a day and is independent of `createdDate`; `plainText=true` keeps the comment plain; a timelog whose `approvalStatus` is Pending or Approved, and other people's, answer 403 on change and are shown locked / read-only; timelogs are not paged; the feed is a 30-day window by `updatedDate`, no deletions reported.
    - If passes: nothing changes.
    - If fails: if the approval field has another name or value set, rename it in `toRemoteWorklog`; if `GET /timelogs` has no `me` or `updatedDate` filter, read per task of the user's recent tasks; if hours are kept at another precision, change `hoursOf`; if the feed pages, add `nextPageToken` handling to `worklogs.changed`; if deletions matter, add a reconciliation by period.
12. **Timelog categories as activities** (`GET /timelog_categories`, `hidden`).
    - Current: visible categories are offered; an unknown id is refused (400).
    - If passes: nothing changes.
    - If fails: if categories are per space, scope them to the task's.
13. **Permanent token and data center**: `Authorization: bearer <token>`; a token only works on its account's data-center host.
    - Current: the connection's API base is `https://www.wrike.com/api/v4` unless the user gives another; a bad token or the wrong host answers 401.
    - If passes: nothing changes.
    - If fails: if the wrong host answers something else (a redirect, a 403), map it to auth with a hint; if the host can be read from the token or `GET /account`, derive the base.
14. **Rate limit**: 429 with `Retry-After` (seconds), else a minute; no budget headers.
    - Current: no rate-limit figure is declared.
    - If passes: nothing changes.
    - If fails: read the real headers and declare `typicalRateLimit`.
15. **Webhook** (`POST /webhooks`, deliveries a JSON list of events with `eventType`, `taskId`, `lastUpdatedDate`; `X-Hook-Secret` = hex HMAC-SHA256 of the raw body under the webhook's secret).
    - Current: the signature is compared in constant time; no secret, no header or a non-hex header is a refusal; no delivery id; the time is the latest event's `lastUpdatedDate`; event types map by prefix (`TaskDeleted` removed, `Task*` changed, `Comment*` comment, `Timelog*` worklog); events stay `signal`. The creation handshake is not handled.
    - If passes: nothing changes.
    - If fails: another header or digest, a handshake to answer when the webhook is created, other event names; a per-event `webhook-wrike-<event>` row before any `full`.

## Basecamp (built on a simulator, not verified on a real account)

The Basecamp adapter (`api/providers/basecamp/`, status `experimental`) was written from Basecamp 3/4's API documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real account. Each assumption is checked on a real account (Basecamp 3 and 4, a project with a card table and one without) before the adapter leaves `experimental`; until then **Current** holds.

1. **Authentication and User-Agent**: an OAuth 2 access token as `Authorization: Bearer`, a `User-Agent` with a contact on every call.
   - Current: a call without `User-Agent` is refused with 400; a bad token is 401; the API root is `https://3.basecampapi.com/<account>`.
   - If passes: nothing changes.
   - If fails: if another status or header is needed, adjust `client.ts`; if no pasted token can work (access tokens expire after two weeks, a refresh token is needed), add an OAuth connect flow like GitHub's.
2. **Account discovery**: `GET https://launchpad.37signals.com/authorization.json` with the same token lists `accounts` (`product: "bc3"` for Basecamp 3 and 4); `options.account` skips it.
   - Current: the only `bc3` account is used; none or several is `invalid` (several: choose in options). The result is kept per token for the life of the process.
   - If passes: nothing changes.
   - If fails: if the launchpad refuses the API token (another audience), require `account` in the options at connect time (the connect form must then ask for it).
3. **Pagination**: pages of 15, the next one in `Link: <...>; rel="next"`, `X-Total-Count`.
   - Current: the next address is followed only on the API's own origin (`incompatible` otherwise); a pass over many to-dos is many calls and the rate limit (50 per 10 s) is met with 429 and `Retry-After` in seconds.
   - If passes: nothing changes.
   - If fails: if the page size or the header differ, adjust `PER_PAGE` and `nextOf`; with no rate-limit headers to read, nothing more is shown than the typical figure (5 per second).
4. **Recordings list** (`GET /projects/recordings.json?type=Todo|Kanban::Card&status=active|trashed&sort=updated_at&direction=desc`).
   - Current: it holds every field of a to-do or card (assignees, completed, due_on, parent, bucket) for everybody's, newest change first; `status=trashed` lists the trash; timestamps carry the account's UTC offset; a pass stops at the first record older than its checkpoint (less 60 s of overlap).
   - If passes: nothing changes.
   - If fails: if the list is a bare record, read each in full (one call per changed record, as the first read does); if `updated_at` does not change on completion, assignment or comments, widen the overlap or read the project timelines (`GET /projects/{id}/timeline.json`) instead.
5. **My assignments** (`GET /my/assignments.json`, first read only): `priorities` and `non_priorities`, each item with `id`, `type`, `bucket`.
   - Current: open items assigned to the user only (no completed ones, no change time), cards included with `type: "Kanban::Card"`; each is then read in full (to-do path first, card path on 404).
   - If passes: nothing changes.
   - If fails: if cards are not listed, read the recordings feed for them on the first pass too (bounded by a window); if the list pages, follow its `Link`.
6. **Soft-deleted recordings**: a trashed or archived to-do or card still answers 200 with `status: "trashed" | "archived"`.
   - Current: such a record reads as not there (`getIssue` null, `findIssue` none); the trashed feed reports the user's trashed recordings as gone `deleted`; archived ones are not reported (no feed for them) and read as not there.
   - If passes: nothing changes.
   - If fails: if a trashed record answers 404, the gone report still comes from the feed; add `status=archived` to the feeds if archived records should be reported gone.
7. **Moving a to-do or card to another project**: a new recording with a new id in the target.
   - Current: the old one is trashed (gone `deleted`), the new one arrives as a new issue; `transfer` stays `none`.
   - If passes: nothing changes.
   - If fails: if the id is kept, the key changes only in its project part (`movedOut` would then be reported by the new project's feed); if the old record answers a redirect, follow it and report `transferred`.
8. **To-do and card paths**: `GET /buckets/{b}/todos/{id}.json` and `/buckets/{b}/card_tables/cards/{id}.json`; the wrong one is a 404; comments, subscription, events and timesheet are on `/buckets/{b}/recordings/{id}/...` for both.
   - Current: as stated; a 403 on a project is read as not there.
   - If passes: nothing changes.
   - If fails: if the recordings path answers a generic `GET`, use it to avoid the second call; if comments on cards need the card path, branch on the type.
9. **Card table**: one per project, found in the project's `dock` (`name: "kanban_board"`), `GET /buckets/{b}/card_tables/{id}.json` with `lists` (columns, `type` `Kanban::Triage`, `Kanban::Column`, `Kanban::NotNowColumn`, `Kanban::DoneColumn`); a card's `parent` is its column; `POST /buckets/{b}/card_tables/cards/{id}/moves.json {column_id}` answers 204.
   - Current: Triage is `triage`, Not now `backlog`, Done `done` (all native); other columns only what `options.columns` maps by title; a card in an unmapped column reads Open or Completed; a card is moved, not completed or reopened by an endpoint of its own; a project has one card table.
   - If passes: nothing changes.
   - If fails: if a project has several card tables, make the board id `<bucket>:<table>` and read each; if the moves endpoint needs a position, send one; if a card has its own completion endpoint, add Complete/Reopen to cards.
10. **To-do completion**: `POST /buckets/{b}/todos/{id}/completion.json` completes, `DELETE` reopens; both answer 204.
    - Current: as stated; the record is read again after.
    - If passes: nothing changes.
    - If fails: adjust the statuses expected.
11. **Comments**: `GET/POST /buckets/{b}/recordings/{id}/comments.json`, `content` in HTML.
    - Current: Basecamp keeps `div, h1, br, strong, em, strike, a, pre, ol, ul, li, blockquote` (and `bc-attachment`) and drops other tags keeping their text; `toBasecampHtml` sends only those; heading levels beyond one, inline code, tables and images are approximated (warnings); the answer to the post is the comment.
    - If passes: nothing changes.
    - If fails: adjust the tag set in `toBasecampHtml`; if `<code>` or `<h2>` is kept, add `code` to the preserved features.
12. **Timesheet entries**: `GET /buckets/{b}/recordings/{id}/timesheet.json`, `POST .../timesheet/entries.json {date, hours, description, person_id}`, `GET/PUT /buckets/{b}/timesheet/entries/{id}.json`, deleting by `PUT /buckets/{b}/recordings/{id}/status/trashed.json`, the report `GET /reports/timesheet.json?from&to&person_id`.
    - Current: `hours` is written as `H:MM` and read as a decimal string with two digits (so 20 minutes is `0.33`, read back rounded to the minute) or `H:MM`; `date` is a plain day; an entry of someone else is read-only (403 on change); a trashed entry still answers 200 and drops out of lists; the report holds active entries only and entries on projects or other kinds of recording are skipped; `person_id` writes on behalf of someone (an admin right, 422 or 403 otherwise).
    - If passes: nothing changes.
    - If fails: if timesheets are a paid add-on and answer 403/404, report time as `forbidden`; if the report has no `person_id` filter, filter by `person.id` here; if `hours` takes only one format, send that one.
13. **Time feed** (`basecamp-time-feed`): the report takes a period, not a change time.
    - Current: a window of 32 days by entry date, read whole at each pass (feed `window` by `entryDate`, 30 days, 2 of overlap), reconciled by period; no removals feed.
    - If passes: nothing changes.
    - If fails: if the report or the recordings feed can filter by change, move to `incremental`.
14. **Events (history)**: `GET /buckets/{b}/recordings/{id}/events.json`, actions `created`, `completed`, `uncompleted`, `assignment_changed` (details `added_person_ids`, `removed_person_ids`), `content_changed`; people by id from `GET /people/{id}.json`.
    - Current: as stated; other actions are shown by name with no values.
    - If passes: nothing changes.
    - If fails: map the names Basecamp really uses; if people come with names, drop the lookup.
15. **Subscription**: `POST/DELETE /buckets/{b}/recordings/{id}/subscription.json` subscribes and unsubscribes the user.
    - Current: both are idempotent.
    - If passes: nothing changes.
    - If fails: if a second call errors, treat it as a success.
16. **Search**: `GET /search.json?q=` finds recordings of every type and everybody's, as bare records.
    - Current: only to-dos and cards are kept, each read in full (at most 40 looked at), and kept when assigned to the user; `complete` is false when cut.
    - If passes: nothing changes.
    - If fails: if `type` or `bucket_id` filters exist, use them to read fewer records; if the search cannot reach a project's to-dos, drop `searchText`.
17. **Webhooks**: created per project (`POST /buckets/{b}/webhooks.json`), a payload with `id`, `kind`, `created_at`, `recording`, `creator`; no signature.
    - Current: a delivery is accepted when its body is such a payload (the secret in the URL is the core's check); `id` is the delivery id, `created_at` its time; a `comment_*` kind is `commentAdded`, any other kind of a to-do or card `issueChanged`. Webhooks are not wired in the app yet.
    - If passes: nothing changes.
    - If fails: if the payload differs, loosen `basecampWebhook.verify`; if there is a signature header after all, check it; if the delivery has no unique id, return null.

## Notion (built on a simulator, not verified on a real account)

The Notion adapter (`api/providers/notion/`, status `experimental`) was written from Notion's documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real workspace. Each assumption below is checked on a real workspace (a free one is enough, with one internal integration) before the adapter leaves `experimental`; until then **Current** holds.

1. **Who the integration is** (`GET /users/me`, `bot.owner`).
   - Current: an internal integration's bot has `owner.type: "workspace"` and names no person, so the person is given in `options.user` (id or email); a public integration has `owner.type: "user"` with the user object.
   - If passes: nothing changes.
   - If fails: if an internal integration's owner is the user who made it, drop the option as the default path and keep it as an override; if `owner.user` has no `id`, read the user through `GET /users/{id}`.
2. **Assigned-pages feed** (`POST /databases/{id}/query`, filter `{ and: [{ property, people: { contains } }, { timestamp: "last_edited_time", last_edited_time: { on_or_after } }] }`, sort by `last_edited_time` ascending, cursors of 100).
   - Current: the filter accepts the property's id (with its `%` escapes) and the timestamp filter in the same `and`; results are complete and ordered; a pass overlaps its checkpoint by 120 s.
   - If passes: nothing changes.
   - If fails: if the property id does not work as `property`, filter by name (and resolve it again each pass); if `and` cannot mix the two kinds, filter the timestamp on the client side.
3. **Rounding of `last_edited_time`** (Notion rounds it to the minute).
   - Current: a page edited after a checkpoint can carry a time up to a minute older; the 120 s overlap covers it; pages already seen are read again within that window (harmless: ingestion is idempotent).
   - If passes: nothing changes.
   - If fails: if the time is exact, shorten the overlap to the clock skew only; if it is rounded to more than a minute, widen it.
4. **Trashed and removed pages** (`archived` / `in_trash`, `GET /pages/{id}`).
   - Current: a query never lists trashed pages; `GET /pages/{id}` still answers with `archived: true` (and `in_trash: true` on newer versions); a page removed for good or not shared answers 404. The adapter keeps the ids of the user's pages (up to 500) in the checkpoint and reads the ones no longer assigned, one request each, to report `deleted`.
   - If passes: nothing changes.
   - If fails: if a trashed page answers 404 or 400, treat that as deleted too (it already is); if a query can list trashed pages (a filter or an `archived` flag), use it to find the deleted ones in one request instead of reading each page.
5. **Light queries** (`filter_properties` as a repeated query parameter of the query endpoint).
   - Current: asking for the title property only returns pages with just that property, which keeps the id-only query small.
   - If passes: nothing changes.
   - If fails: if the parameter is ignored or refused, the query is read whole (more payload, same result).
6. **Status property** (`type: "status"` with `groups`, `type: "select"`).
   - Current: a Status property lists `options` and exactly three `groups` in the order To-do, In progress, Complete, each with `option_ids`; the category is read from the group index; a Select property has options only. A page is moved with `{ properties: { <property id>: { status: { id } } } }` (`select` for a Select property), by the property's id as returned (URL-escaped characters included).
   - If passes: nothing changes.
   - If fails: if the groups are not three or not in that order, read them by name; if the property id does not work as a key, write by name; if a status option cannot be set by id, send its name.
7. **Page and database ids and links** (dashed UUIDs in the API; 32 hex characters in URLs; `?p=` for a page peeked in a database view; `?v=` a view).
   - Current: the key is the 32 hex characters; a link's trailing 32 hex characters are the page's, `?p=` wins; the database's own id gives a 400 on `GET /pages/{id}` ("is a database"), read as "no such page".
   - If passes: nothing changes.
   - If fails: if the database's id answers 404 instead, nothing changes (both are "none"); if links of another shape exist (`notion.site`, workspace subdomains), add their hosts to `parseRef`.
8. **Unique id property** (a database may have a `unique_id` property giving `PREFIX-12`).
   - Current: not used; the key is the page id.
   - If passes: nothing to do.
   - If fails: if people expect `TASK-12` keys, use the property as the key (a filter `{ property, unique_id: { equals } }` finds it) and keep the page id as the remote id.
9. **Comments** (`GET /comments?block_id=<page id>`, `POST /comments { parent: { page_id }, rich_text }`).
   - Current: listing by page id returns the page's own comments oldest first (not those on blocks of the body); `created_by` is only `{ id }`, so authors are read with `GET /users/{id}` once each; a missing capability is a 403 `restricted_resource`; a text is at most 2,000 characters in one element and at most 100 elements; the comment posted by the integration is authored by the bot.
   - If passes: nothing changes.
   - If fails: if block comments appear in the page's list, filter by `parent`; if the limits differ, change `RICH_TEXT_MAX` and `RICH_ELEMENTS_MAX`; if a bot cannot be read with `/users/{id}`, take its name from the comment's own data.
10. **Dates** (`date: { start, end, time_zone }`).
    - Current: `start` is a day, an instant with an offset (read in the user's zone), or a time with no offset and a `time_zone` beside it (the date part is kept, in that zone).
    - If passes: nothing changes.
    - If fails: if a no-offset time is meant in the workspace's zone or in UTC, convert it with the zone it names before taking the day.
11. **Description** (`GET /blocks/{page id}/children`, cursors of 100).
    - Current: the page's top-level text blocks are read as Markdown; nested blocks (toggles, columns, sub-items) are not.
    - If passes: nothing changes.
    - If fails: if people keep their descriptions inside toggles or callouts, read children recursively up to a depth and page limit.
12. **Rate limit** (an average of 3 requests a second; 429 `rate_limited` with `Retry-After` in seconds).
    - Current: the probe reports 3 per second (`typical`); a 429 waits `Retry-After`, 1 s when it is absent.
    - If passes: nothing changes.
    - If fails: if the header is in another unit or absent, use the documented average; if bursts are allowed, raise the figure.
13. **Webhooks** (`X-Notion-Signature: sha256=<hex>` over the raw body with the subscription's verification token; body `{ id, timestamp, type, entity, data }`; a first request carries only `verification_token`).
    - Current: the connection's webhook secret is the verification token; `id` is the delivery id and `timestamp` (ISO) the send time; `page.*` events are `issueChanged`, `comment.created` is `commentAdded`; deliveries are signals (the page is read again).
    - If passes: webhooks can be offered, with the public address they need.
    - If fails: if the signature covers something else or uses another prefix, change `notionWebhook.verify`; if event names differ, change `notionWebhook.event`; polling stays the way to sync meanwhile.
14. **API version** (`Notion-Version: 2022-06-28`).
    - Current: databases are read as one table with `properties`; the query is `POST /databases/{id}/query`.
    - If passes: nothing changes.
    - If fails: a newer version (2025-09-03 and later) puts a database's tables in data sources (`/data_sources/{id}/query`, a database can have several): the adapter then needs the data source's id, and a decision on which one to read.

## monday.com (built on a simulator, not verified on a real account)

The monday.com adapter (`api/providers/monday/`) and its simulator were written from monday's public GraphQL API documentation, with no call to a real account. Each assumption below is held as **Current** until a read-only run on a real account (personal API token; queries first, mutations only on a scratch board) shows it. The adapter is registered `experimental` until they pass. All stay open.

1. **Token header and schema version.** A personal token goes in `Authorization` as is, an OAuth token as `Bearer`; `API-Version: 2025-07` pins the schema.
   - Current: token as is, version sent on every call; a bad token modelled as a 401 in the flat `{error_code, error_message}` shape, other failures as HTTP 200 with `errors`.
   - If passes: nothing changes.
   - If fails: fix the header in `client.ts`; read the real shape of a bad-token answer in `refused`; move to a newer version if 2025-07 is retired.
2. **Error codes.** `COMPLEXITY_BUDGET_EXHAUSTED` (with `retry_in_seconds`), `ComplexityException`, `RateLimitExceeded`, `DAILY_LIMIT_EXCEEDED`, `UserUnauthorizedException`, `ResourceNotFoundException`, `InvalidBoardIdException`, `InvalidColumnIdException`, `ColumnValueException`, a cursor error.
   - Current: the sets in `client.ts` (`RATE`, `NOT_FOUND`, `INVALID`); a cursor error is any code or message naming a cursor, read as `invalidCheckpoint`; the same `UserUnauthorizedException` is `auth` on a 401 and `forbidden` otherwise.
   - If passes: nothing changes.
   - If fails: correct the sets; record the real wait for a spent budget and for the daily limit.
3. **Complexity budget.** A query's cost counts what it asks for; one query is capped at 5,000,000 points, a minute at about 10,000,000.
   - Current: 50 items a page, 5 boards of 25 items a search query, the rest in `PER_PAGE`, `SEARCH_BOARDS` and `BOARDS_PER_PAGE`; a spent budget is a `rateLimit` wait.
   - If passes: page sizes can grow towards the cap, measured from the `complexity` field.
   - If fails: smaller pages (each item carries its board's columns), or ask for the board's columns once per board.
4. **People filter.** `items_page(query_params: {rules: [{column_id, compare_value: ["person-<id>"], operator: any_of}]})` finds the items held by a user, on the board's first people column (`person` by id, else the first).
   - Current: one people column per board; teams (`team-<id>`) and a second people column are not searched.
   - If passes: nothing changes.
   - If fails: another operator or value format; or read whole boards and filter here.
5. **Last-updated filter.** A rule on `__last_updated__` with `["EXACT", "YYYY-MM-DD"]` and `greater_than_or_equals` takes a day, not a moment, in the account's zone.
   - Current: a day early (UTC), then the exact cut on `updated_at` here; the checkpoint is the pass start less 60 s.
   - If passes: nothing changes.
   - If fails: another column id or operator, or read every item of the board and cut here.
6. **Does a change touch `updated_at`?** A cell change, a move to another board, an archive, and a new update (comment) all bump the item's `updated_at`.
   - Current: assumed; an item moved to another board is found again under its new key by the incremental pass.
   - If passes: nothing changes.
   - If fails: add the activity log's `move_pulse_into_board` and `create_update` events to the changed set; or full passes.
7. **Cursors.** `items_page` returns a cursor valid about an hour, taking no filters on the next call; `next_items_page(cursor, limit)`.
   - Current: an expired cursor is `invalidCheckpoint` (the pass starts over).
   - If passes: nothing changes.
   - If fails: another error code for it, or a shorter pass.
8. **Boards list.** `boards(limit, page, state: active, order_by: created_at)` pages by number (100 at most) and lists subitem boards and documents.
   - Current: 25 a page, skipping documents and boards without a people and a status column; a board created mid-pass can shift the pages (the next pass finds it).
   - If passes: nothing changes.
   - If fails: add `type` filters, or order by something stable.
9. **Departures.** `activity_logs(from, to)` on a board has `delete_pulse` and `archive_pulse` events with `data.pulse_id`; the log's `created_at` is 17 digits (tenths of a microsecond); `data` is JSON in a string.
   - Current: both events reported as `deleted`; items handed to someone else are not (the catalogue keeps `movedOut: false`).
   - If passes: nothing changes.
   - If fails: other event names; a retention shorter than the sync interval makes deletions go unseen, and reconciliation finds them.
10. **Deleted items by id.** `items(ids)` still answers for a deleted item, with `state: deleted`; an unknown id is an empty list.
    - Current: deleted and unknown are both `none`/`null`; an archived item is still readable.
    - If passes: nothing changes.
    - If fails: map the real error or state.
11. **Moves between boards.** The item keeps its id and takes the new board; its old key still resolves by id.
    - Current: found under the new key, so the engine aliases the old one.
    - If passes: nothing changes.
    - If fails: an old key is `none`; the engine finds the item by id only.
12. **Status column.** The workflow is the column with the id `status`, else the first status column that is not `priority`; its `settings_str` JSON has `labels`, `labels_positions_v2`, `labels_colors`, `done_colors`; a cell is `{index, changed_at}`; set with `change_column_value` and `{"index": n}` in a JSON string.
    - Current: as written; the column type is `status` (`color` in older schemas is also read).
    - If passes: nothing changes.
    - If fails: fix `labelsOf`, or set by label name (`change_simple_column_value`).
13. **Categories.** Only `done_colors` and the empty label are monday's to say; every other label is "todo" unless the connection's `categories` option maps its name.
    - Current: as written; no label is "backlog".
    - If passes: keep; consider a mapping screen like Trello's.
    - If fails: derive "doing" from the default labels' colours or indexes if monday keeps them stable.
14. **People, date, timeline, tags and time tracking cells.** People `{personsAndTeams: [{id, kind}]}` with ids as numbers; date `{date, time}` with the time in UTC; timeline `{from, to}`; tags `{tag_ids}` with names only in `text`; time tracking `{duration, running, startDate}` with `running` a string and `duration` in seconds; column types `people` (`multiple-person` in older schemas), `time_tracking` (`duration` in older ones).
    - Current: as written; a running timer counts up to now; tags are split on `,` from the cell's text.
    - If passes: nothing changes.
    - If fails: fix `toRemoteIssue` and `trackedSeconds`; read tags through the `tags` field.
15. **Updates.** `items(ids){ updates(limit, page) { body creator replies } }` newest first, body HTML; `create_update(item_id, body)`; a creator who left is null.
    - Current: replies are flattened into the list, oldest first; a user who left is "Deleted user".
    - If passes: nothing changes.
    - If fails: fix the paging (limit, page) and the reply shape.
16. **HTML an update keeps.** `<p>`, `<strong>`, `<em>`, `<a href>`, `<ul>`, `<ol>`, `<li>` survive; the catalogue's write-preserves list is exactly these.
    - Current: headings, quotes, code and tables are written as paragraphs and warned.
    - If passes: nothing changes.
    - If fails: shorten `writePreserves`, or send a different subset; maybe `<br>` between lines.
17. **Description.** monday has no description field: a long text column with the id or title `description` stands in.
    - Current: plain text from the cell's `text`; none when the board has no such column.
    - If passes: keep.
    - If fails: read the first update, or the item's doc column; or declare `description: false` in the catalogue.
18. **Webhooks.** Deliveries carry `Authorization: <JWT HS256>` signed with the app's signing secret and an `exp`; the body is `{event: {..., triggerUuid, triggerTime}}`; a new subscription gets `{challenge}` first and wants it echoed.
    - Current: `mondayWebhook.verify/deliveryId/sentAt/challengeOf` in `adapter.ts`, not yet wired (webhooks are the last provider work); payloads stay `signal`. Webhooks made with a personal token through `create_webhook` may carry no JWT.
    - If passes: nothing changes.
    - If fails: fix the claims checked, or declare no webhooks for a personal-token connection.
19. **Rate figure.** monday's request limits per minute and per day depend on the plan.
    - Current: `perHour: 30000`, origin `typical`.
    - If passes: replace by what the `complexity` field and the plan documentation give.
    - If fails: same.
20. **Time.** The time tracking column is readable and not writable through the API.
    - Current: `time: local, remoteTotals: true`; `spentSeconds` from the first time tracking column.
    - If passes: keep.
    - If fails: if a write exists, a new capability (a counter or entries) is a catalogue change, not a quiet one.

## ClickUp (built on a simulator, not verified on a real account)

The ClickUp adapter (`api/providers/clickup/`, status `experimental`) was written from ClickUp's API v2 documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real account. Each assumption is checked on a real account (a free workspace, and one with Custom Task IDs and the Time Tracking ClickApp on) before the adapter leaves `experimental`; until then **Current** holds.

1. **Authorization header**: the personal token (`pk_…`) alone.
   - Current: `Authorization: <token>` with no `Bearer`; `Bearer <token>` answers 401 (`OAUTH_025`). An OAuth access token is sent the same way.
   - If passes: nothing changes.
   - If fails: if a personal token needs `Bearer`, add it in `client.ts`; if OAuth tokens need it and personal ones do not, send it for the `oauth` credential only.
2. **Assigned-tasks feed** (`GET /team/{team_id}/task?assignees[]=<me>&subtasks=true&order_by=created&page=n`, plus `include_closed=true` and `date_updated_gt=<ms>`).
   - Current: closed tasks (status types closed and done) and subtasks are left out unless asked for; 100 a page, `page` from 0, `last_page` present (the adapter falls back to "fewer than 100"); `date_updated_gt` is exclusive and in Unix ms; a first read is two passes a workspace (open tasks, then everything changed in 30 days, keeping the closed ones); a pass overlaps its checkpoint by 60 s; `order_by=created` keeps page numbers good while tasks are edited.
   - If passes: nothing changes.
   - If fails: if `assignees[]` also matches tasks only watched by the user, filter on `assignees` in the answer; if `date_updated_gt` ignores comment or time changes, drop to a full read on a timer; if closed tasks can be filtered by status type, replace the second pass.
2a. **Tasks in several lists**: the `list` of a task is its home list.
   - Current: the home list is the container; a task shown in other lists (Tasks in Multiple Lists) is not duplicated.
   - If passes: nothing changes.
   - If fails: if the filtered list returns the task once per list, deduplicate on id.
3. **Task ids and keys**: `id` is an alphanumeric string (`86c0abc12`); `custom_id` is set when the workspace has Custom Task IDs.
   - Current: key = `custom_id` uppercased, else `CU-<id>` lowercase; `CU-` + 6 to 12 letters and digits is a default key (a custom id with prefix `CU` is not told apart); a custom id is looked up with `GET /task/{id}?custom_task_ids=true&team_id=<team>` in each workspace, and only that way (the plain id answers 404 with the flag, the custom id 404 without); a 400 from a workspace without custom ids is read as "not there"; custom ids are matched case-insensitively.
   - If passes: nothing changes.
   - If fails: if lookups are case-sensitive, keep the case ClickUp returns instead of uppercasing; if the plain id works under the flag, drop the two-way lookup; if `CU-<id>` is not what ClickUp shows, change the prefix.
4. **A task out of reach**: ClickUp answers 401 with `ECODE: OAUTH_027` ("Team not authorized") for a task, list or workspace the token cannot reach, not 403.
   - Current: `OAUTH_023` and `OAUTH_027` on a 401 are read as forbidden (a task not found, an operation not found), never as a failed token; any other 401 is auth.
   - If passes: nothing changes.
   - If fails: if a deleted task answers 401 too, nothing changes; if an expired token answers one of these codes, narrow the list to `OAUTH_027`.
5. **Links**: `app.clickup.com/t/<id>` and `app.clickup.com/t/<workspace>/<id or custom id>`.
   - Current: the second segment is a custom id when it looks like one (`ENG-12`), else a task id.
   - If passes: nothing changes.
   - If fails: add the forms the app really produces (`/t/<workspace>/<list>/<id>`, share links).
6. **Dates**: every date is Unix ms as a string.
   - Current: parsed with `Number`; a due date without a time (`due_date_time` false) is the instant 04:00 in the zone of whoever set it and is read on the connection's zone's day; a timed due date is an instant read the same way.
   - If passes: nothing changes.
   - If fails: if date-only due dates are stored at another hour or in UTC, read them in that zone (use `due_date_time` to tell the two); the 04:00 is the assumption to check first, with a user in a far-away zone.
7. **Statuses**: per list, each with `type` (open, custom, done, closed).
   - Current: the status name lowercased is its id; categories: open to todo, custom to doing, done and closed to done (`closed` is not read as cancelled); `GET /list/{id}` gives the list's statuses; `PUT /task/{id}` with `{ status: <name> }` sets one (a status the list does not have answers 400); `GET /team/{id}/space` gives the space statuses for the unscoped listing.
   - If passes: nothing changes.
   - If fails: if the status is matched by id, send the id; if the `done` type is absent on older workspaces, nothing changes; if a "closed" status should be cancelled, add a mapping option.
8. **Descriptions**: `markdown_description` with `include_markdown_description=true`.
   - Current: read as `gfm`, falling back to the plain `description`.
   - If passes: nothing changes.
   - If fails: if the Markdown is a different dialect, read as `commonmark` or `html`.
9. **Comments, reading**: `GET /task/{id}/comment`, 25 a call, newest first, continued with `start` (ms) and `start_id` of the oldest seen; each comment has `comment` (blocks) and `comment_text`.
   - Current: the blocks are the structured body (`rich`) with a Markdown preview built from bold, italic, strike, code, link, list, quote, code-block, mention and image blocks; comments sharing a millisecond are not lost because `start_id` is sent; the `id` of a comment is a string.
   - If passes: nothing changes.
   - If fails: if paging needs `start` only or another cursor, change `comments.list`; if blocks differ from the assumed shape, fall back to `comment_text` (`plain`); if the order is oldest first, nothing else changes (the adapter sorts).
10. **Comments, writing**: `POST /task/{id}/comment` with `{ comment_text }`.
    - Current: `comment_text` is plain text; Markdown marks are not rendered, so everything but paragraphs is flattened with a warning; the answer is `{ id, hist_id, date }` only, so the comment is read again (`comment: null`).
    - If passes: nothing changes.
    - If fails: if `comment_text` renders Markdown, widen `writePreserves` in the catalogue; if the structured `comment` array can be sent, write blocks (bold, italic, code, link, lists) and widen it the same way.
11. **Watching**: `PUT /task/{id}` with `{ watchers: { add: [<me>], rem: [] } }`.
    - Current: setting it twice is fine.
    - If passes: nothing changes.
    - If fails: if the public API has no watcher update, set `watch: false` in the catalogue and remove the operation.
12. **Time entries** (`/team/{team_id}/time_entries`): `start`, `end`, `duration` in ms strings, `billable`, `description`, `task`, `user`, `at`.
    - Current: without `start_date`/`end_date` the list is the last 30 days and the user's own entries, which is the window feed's lookback; the dates filter on an entry's start; a listing of one task passes `task_id` with a wide `start_date` and `end_date` (assumed accepted: no maximum range); a running timer has a negative duration and is skipped; time on no task has `task` empty or `"0"`; create takes `{ tid, start, duration, description, billable }` and answers `{ data: entry }`; update takes the same and answers `{ data: [entry] }` (the adapter reads a record or a list); delete answers a list and a missing entry 404 (treated as done); `at` is the last change in ms and is what the feed filters on; other people's entries are not listed and cannot be changed (403).
    - If passes: nothing changes.
    - If fails: if the wide range is refused, page `task_id` queries in year-long windows or use `GET /task/{id}/time`; if `at` is not the last change, drop the feed (`kind: none`) and rely on the period reconcile; if the ClickApp-off error is not 403, adjust `forbidden` handling in `worklogs.changed`.
13. **Time entry limits**: none declared (`limits: {}`), `idempotency: local`, `concurrency: none`.
    - Current: the minimum and maximum duration, a future start and a closed period are not checked by the adapter.
    - If passes: nothing changes.
    - If fails: add the limits found (`minSeconds`, `noFuture`) to the capabilities and the catalogue together.
14. **Task time fields**: `time_estimate` and `time_spent` in ms.
    - Current: `time_spent` is present on the task (only when time was tracked) and is the sum of all users' entries on it; `time_estimate` null when unset.
    - If passes: nothing changes.
    - If fails: if `time_spent` is absent from the filtered list, read it from the entries instead or omit it.
15. **Rate limit**: 100 requests a minute, with `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds), 429 with no `Retry-After`.
    - Current: the probe reads the limit header from `/user` as a per hour figure (limit x 60); a 429 waits until the reset (at least 1 s).
    - If passes: nothing changes.
    - If fails: if `Reset` is in milliseconds or relative, fix the conversion in `client.ts`; if there is a `Retry-After`, prefer it.
16. **Webhooks**: `X-Signature`, the hex HMAC-SHA256 of the raw body under the webhook's secret; the body has `webhook_id`, `event`, `task_id`, `history_items` (each with `id`, `date`).
    - Current: no delivery id header: the webhook id with the first history item's id is the id (null when there is no item); the age is the latest item's date; `taskTimeTrackedUpdated` is read as both a change and a removal of time (the payload does not tell them apart); other task events are `issueChanged`.
    - If passes: nothing changes.
    - If fails: if the signature is not over the raw body or not hex, fix `clickupWebhook.verify`; if the payload tells a removal (`after` null), narrow `events`; if events carry an id, use it.

## Everhour (built on a simulator, not verified on a real account)

The Everhour sink (`api/providers/everhour/`, status `experimental`) and its simulator were written from Everhour's public API documentation, with no call to a real account. Each assumption below is held as **Current** until a run on a real account (a personal API key from My Profile > Settings > Application access; reads first, writes only on a scratch Everhour task) shows it. All stay open.

1. **Base and credentials.** The API root is `https://api.everhour.com`, the personal key goes in `X-Api-Key`, the version in `X-Accept-Version: 1.2`.
   - Current: `client.ts` (`eh`) sends both on every call; the simulator refuses a missing or wrong key with 401.
   - If passes: nothing changes.
   - If fails: change the header or the version in `client.ts`; if the key must also be passed another way, add it there only.
2. **Who the key is.** `GET /users/me` answers `{ id, name, email, headline, role, status }`, with a numeric id.
   - Current: `verify` and `probe` read it; the id is the author of every record.
   - If passes: nothing changes.
   - If fails: read the user from the first time record, or from `/team/users`.
3. **Reading a period.** `GET /users/me/time?from=&to=&limit=&page=` lists the key owner's records (`{ date, time, user, task: { id, name }, comment, history }`), both ends included, plain days.
   - Current: `entries.list` pages until an empty page (the service may cap `limit` below the 200 asked); it filters to the range and drops zero-second records.
   - If passes: nothing changes.
   - If fails: if the path is `/users/{id}/time` or `/team/time?userId=`, fix `entries.list`; if paging is by cursor or `offset`, change `ehPages`.
4. **Setting a day.** `PUT /tasks/{task}/time` with `{ time, date, comment }` replaces the key owner's time of that task on that day; POST adds to it.
   - Current: `setDayTotal` always PUTs, so a retry is harmless; the answer is read for its record, with the request as fallback.
   - If passes: nothing changes.
   - If fails: if PUT does not replace, read the day's current total (list one day) and POST the difference, under the same retry rule.
5. **Zero removes.** `time: 0` removes the record; removing one that is not there is a success (200 or 404).
   - Current: `seconds === 0` returns null and takes a 404 as done.
   - If passes: nothing changes.
   - If fails: use `DELETE /tasks/{task}/time` with the date (and the user) for a total of 0.
6. **Seconds and plain days.** `time` is whole seconds up to 24 hours; `date` is a plain `YYYY-MM-DD` of the user's own day, with no zone.
   - Current: the adapter refuses fractions, negatives and over 24 h before calling; the day is the one the engine counted in the connection's time zone.
   - If passes: nothing changes.
   - If fails: if the day is counted in the workspace's zone and differs from the user's, read it at `/users/me` and shift the day in `setDayTotal`; if the cap is not 24 h, move it to `limits.maxSeconds`.
7. **Task ids.** An integration's task is `<prefix>:<tracker id>`: `ji` (Jira issue id), `gh`, `gl`, `as`, `tr`, `b3`, `cl`, `td`, `wr`.
   - Current: `EVERHOUR_PREFIX` in `adapter.ts`; a tracker not in it is refused (`invalid`) without a call.
   - If passes: nothing changes.
   - If fails: fix each wrong prefix or the id it takes (key or number rather than id); add the trackers Everhour does integrate with that are missing (Azure DevOps, Linear, monday…).
8. **The task must exist.** Time on a task Everhour has not imported is a 404.
   - Current: refused as `invalid`, with "add the issue's project to Everhour first" (not retried).
   - If passes: nothing changes.
   - If fails: if Everhour creates the task on first use, drop the message; if it needs `POST /projects/{project}/tasks` first, the sink needs a project target (`target.use` "optional") and the catalogue entry changes.
9. **Notes.** A time record has a `comment`; it is written as `KEY: title`.
   - Current: sent with every PUT; read back as the record's comment.
   - If passes: nothing changes.
   - If fails: if the time endpoint has no comment, drop it (the issue key and title then live only on the task) and say so in the docs.
10. **Locked time.** A locked period or approved time is refused with 403 and a message that says it is locked; the list marks the record `locked`.
    - Current: a 403 whose message says lock/locked/approved/closed is `conflict`; a record with `locked` is listed approved, locked, not editable.
    - If passes: nothing changes.
    - If fails: map the real status and field (a different word, a `status: "approved"` on the record or a separate `/timesheets` read) in `refused` and `toWorklog`; if approvals are not readable at all, set `approvals.read` to false.
11. **Running timers.** `GET /timers/current` answers `{ status: "active", startedAt, task, duration }` or `{ status: "stopped" }`; a stopped timer adds its time to the day it started on.
    - Current: a total is not set while a timer is running on the same task and the date is the timer's start day or today (`conflict`).
    - If passes: nothing changes.
    - If fails: if a timer's time counts at the day it stops, or in the workspace's zone, change which days are guarded; if a running timer does not interfere, drop the guard.
12. **Rate limit.** 20 requests per 10 seconds per key, a 429 with `Retry-After`; no usable headers.
    - Current: the wait is `Retry-After` seconds, else 10 s; no budget is reported by the probe (`everhour-rate-limit` stays open in `docs/dev/spikes.md`).
    - If passes: declare `typicalRateLimit: { perHour: 7200 }` and report it from the probe.
    - If fails: read the real headers in `refused`/`probe`; an hourly or daily quota on the plan goes in `typicalRateLimit`.
13. **Plans.** A plan without API access answers 403 (not a lock).
    - Current: `forbidden`, with Everhour's wording.
    - If passes: nothing changes.
    - If fails: map the real status and wording of a plan limit in `refused`.

## Clockify (built on a simulator, not verified on a real account)

The Clockify sink (`api/providers/clockify/`, status `experimental`) was written from Clockify's public API documentation (v1) and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real server. Each assumption is checked on a real account (a free workspace, plus a paid one with approvals and forced projects) before the adapter leaves `experimental`; until then **Current** holds. `clockify-rate-limit` also has its row in the table of `docs/dev/spikes.md`; it is repeated here so the whole list is in one place.

1. **Entries list filters** (`GET /workspaces/{w}/user/{u}/time-entries?start=…&end=…&page=…&page-size=…`).
   - Current: `start` and `end` are ISO instants (`yyyy-MM-ddThh:mm:ssZ`, a date-only value is a 400) and both bound the entry's **start**; a local day is sent as its start instant to the last second before the next day's start, in the connection's zone; the list is newest first and includes a running timer, which the adapter drops.
   - If passes: nothing changes.
   - If fails: if `end` bounds the entry's end instead, read one day wider at the start and filter by start in the adapter; if date-only values are accepted nothing changes (instants still work).
2. **Paging** (`page`, `page-size`, no total).
   - Current: a page shorter than `page-size` (200) is the last; the service caps a page at 1000; an exact multiple costs one empty page.
   - If passes: nothing changes.
   - If fails: if a `Last-Page` header or a total is sent, stop on it; if the cap is lower than 200, lower `PAGE_SIZE` to what it allows.
3. **Create** (`POST /workspaces/{w}/time-entries`, body `start`, `end`, `description`, `billable`, `projectId`, `taskId`; for another user `POST …/user/{u}/time-entries`).
   - Current: an end is always sent (a request without one starts a timer and stops the running one); times have no milliseconds; billable is omitted unless the input says, and then the project's setting applies; the answer is the entry (201).
   - If passes: nothing changes.
   - If fails: if milliseconds or an offset instead of `Z` are required or refused, change `isoOf` only; if billable defaults differently, send it always (from the project).
4. **Update is a full replace** (`PUT /workspaces/{w}/time-entries/{id}`).
   - Current: `start` is required; `projectId`, `taskId`, `tagIds`, `billable` and `description` not sent are cleared, so the adapter reads the entry (`GET …/time-entries/{id}`) and sends them back.
   - If passes: nothing changes.
   - If fails: if omitted fields are kept (a patch), drop the read before the write and save a request.
5. **Delete** (`DELETE …/time-entries/{id}`).
   - Current: 204; an entry already gone is a 404 and counts as a success.
   - If passes: nothing changes.
   - If fails: if a gone entry answers 400 with a code, tell it by the message and treat it as gone.
6. **Idempotency**: none.
   - Current: `idempotency: "local"`; a retried create makes a second entry.
   - If passes: nothing changes.
   - If fails: if a header or a client-side id is honoured, switch to `native`.
7. **Locked and approved entries**: an entry in an approved or submitted timesheet, or in a locked period, has `isLocked: true` and any change answers 400 (or 403) with a message that says so.
   - Current: the adapter reads the lock from `isLocked`, never tries to change a locked entry, and maps a refusal whose message mentions "lock", "approved", "submitted" or "closed period" to `conflict`; any other 4xx is `invalid`/`forbidden` by status.
   - If passes: nothing changes.
   - If fails: if the refusal has a stable `code`, map by code instead of by words (the words may be localized); if `isLocked` is not on the list payload, fall back on the refusal alone.
8. **Approval state** (`GET /workspaces/{w}/approval-requests`, listed for workspace managers only).
   - Current: read only when an entry is locked; a 403 means "unknown" (the lock is then `periodClosed`); a request covers the entries whose start falls in its `dateRange`; `PENDING` reads as submitted, `APPROVED` as approved, `REJECTED` unlocks.
   - If passes: nothing changes.
   - If fails: if the payload or the filters differ (status filter, owner id), change the read only; if no read is possible for a plain key, `approvals.read` stays declared and the state is simply absent.
9. **Required project and task**: a workspace can force a project, or a task; a task needs its project; an archived project takes no new entries; a description is at most 3000 characters.
   - Current: each is a 400 with a message, `invalid`; the adapter always sends a task with its project, and cuts the comment (keeping the first line) at 3000.
   - If passes: nothing changes.
   - If fails: if an over-long description is cut by Clockify instead of refused, the cut is only redundant; if a forced project falls back on a default, the failure stops appearing.
10. **Targets** (`GET …/projects?name=…&archived=false`, `GET …/projects/{p}/tasks?is-active=true`).
    - Current: `name` is a "contains" filter; tasks are listed per project (first five matches); finished tasks (`status: DONE`) are left out.
    - If passes: nothing changes.
    - If fails: if `name` is a prefix match, the search narrows; if `hydrated=true` returns tasks with the projects, use it to save the per-project requests.
11. **Workspace and user** (`GET /user`: `activeWorkspace`, `defaultWorkspace`, `profilePicture`; `GET /workspaces`).
    - Current: the connection's workspace option, else `activeWorkspace`; the user's id is the connection's account id and is used in the entries path.
    - If passes: nothing changes.
    - If fails: if the active workspace is unreliable for keys of several workspaces, the option becomes required in the form.
12. **Rate limit** (`clockify-rate-limit`): 50 requests per second per key (per add-on); over it a 429, maybe with `Retry-After`.
    - Current: a 429 waits `Retry-After`, else a second; the probe reports `perSecond: 50, origin: typical`; no `typicalRateLimit` is declared as a capability.
    - If passes: declare `typicalRateLimit: { perSecond: 50 }` (and its scope in the limiter's configuration).
    - If fails: throttle from 429 and `Retry-After` only; the probe drops the typical figure.
13. **Entries for another user** (`POST …/user/{u}/time-entries`, admins only).
    - Current: a plain key gets 403 (`forbidden`); `onBehalf` is declared read and write because an admin's key may.
    - If passes: nothing changes.
    - If fails: if it is a paid-plan feature, the probe narrows `onBehalf.write` to false on a free workspace.

## Harvest (built on a simulator, not verified on a real account)

The Harvest adapter (`api/providers/harvest/`, status `experimental`) was written from Harvest's API v2 documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real account. Each assumption is checked on a real account (a free Harvest account with a duration setting, and one with timestamps on) before the adapter leaves `experimental`; until then **Current** holds. Nothing here is a row of the spikes table: no catalogue value for harvest is marked "(verify: …)".

1. **Authentication headers**: `Authorization: Bearer <personal access token>`, `Harvest-Account-Id: <account id>` and a `User-Agent`.
   - Current: all three are sent on every call (`User-Agent: inkledger (https://github.com/inkledger/inkledger)`); a call without a User-Agent is refused (400); a bad token answers 401 and a token that cannot reach the account id answers 403.
   - If passes: nothing changes.
   - If fails: if a wrong account id answers 401 (or 404), it still reads as `auth`/`notFound` and the connection form asks to check the account id; if the User-Agent must carry an email, make it a setting.
2. **Hours and their precision**: an entry's `hours` is a decimal number.
   - Current: hours are sent with two decimals (36 s steps, nearest); the entry reads back `hours × 3600` seconds, so 90 s reads back 108 s and 1 h 1 min reads back 1 h 1 min 12 s; under 18 s and over 24 h are refused before the call.
   - If passes: nothing changes.
   - If fails: if Harvest keeps more precision (seconds, or four decimals), send `seconds / 3600` rounded to four decimals and drop the 36 s step; if it keeps fewer (15 minutes by account setting, `rounded_hours`), read `rounded_hours` where `hours` and it disagree and say so on the entry.
3. **Dates and zones**: `spent_date` is a date with no zone, `created_at` and `updated_at` are UTC, `from`/`to` filter on `spent_date`, `updated_since` is a UTC instant.
   - Current: `spent_date` is the day of the worklog in the connection's zone; a list over `[from, to]` sends both dates (inclusive); `updated_since` is sent as an ISO UTC instant and is inclusive (a pass overlaps its checkpoint by an hour).
   - If passes: nothing changes.
   - If fails: if `updated_since` is exclusive or coarser than a second, widen the overlap; if `from`/`to` follow the Harvest user's own zone and it differs from the connection's, take the zone from `users/me.timezone` for dating entries.
4. **Time of day**: duration accounts keep no start; timestamp accounts keep `started_time`/`ended_time` ("8:30am").
   - Current: the account's mode is read from `GET /company` (`wants_timestamp_timers`) before each write. A duration account is sent `hours`; a timestamp account is sent `started_time` and `ended_time` (the start to the minute in the connection's zone, the end after the rounded length) and never `hours`; an entry that would reach midnight is refused. A duration entry reads back as a session starting at the start of its day in the connection's zone; a timestamp entry at its `started_time` in the same zone.
   - If passes: nothing changes.
   - If fails: if timestamp accounts accept (or need) `hours` beside the times, send both and let the end cross midnight as the account allows; if `started_time` is in the Harvest user's zone, convert it with `users/me.timezone`; if duration accounts refuse a start, the adapter already never sends one.
5. **Running timers**: an entry created with neither `hours` nor `ended_time` starts a timer.
   - Current: every create sends the length, so no entry of ours runs; lists ask `is_running=false` and also drop running rows, so a timer started in Harvest is not read until it stops (its `updated_at` then puts it in the window feed).
   - If passes: nothing changes.
   - If fails: if `is_running` is not a filter, the client-side drop already covers it; if a stopped timer does not move `updated_at`, the period reconciliation still finds it.
6. **Required project and task**: `project_id` and `task_id` are required and must be an assignment of the user (`GET /users/me/project_assignments`, nested `task_assignments`).
   - Current: a target is `projectId:taskId`; search lists only active project assignments with active task assignments, over `client / project / code / task` text; an archived project, or a task assignment withdrawn since, is refused by Harvest with a 422 read as `invalid`.
   - If passes: nothing changes.
   - If fails: if inactive assignments are also usable for tracking, drop the `is_active` filter; if the task list is not nested in `project_assignments` (older accounts), read `GET /projects/{id}/task_assignments`.
7. **Locked, approved and invoiced entries**: `is_locked` (+ `locked_reason`), `is_closed` (Timesheet Approval), `is_billed` (invoiced).
   - Current: `is_billed` reads as locked `invoiced`, `is_closed` as `approved` (and approval `approved`), `is_locked` otherwise as `other` (`approved` when the reason says so); all are not editable; a change or delete is refused with a 422 whose message mentions locked, approved, closed or invoiced, read as `conflict`.
   - If passes: nothing changes.
   - If fails: if Harvest answers 403 (or another 4xx) for these, map that status to `conflict` for update and delete only; if approval has more states (submitted, rejected) in the API, read them into `approval`.
8. **`external_reference`**: `{ id, group_id, account_id, permalink }`.
   - Current: `id` is the issue's id on its tracker, `group_id` its project (when the issue has one), `account_id` is `<tracker type>:<connection id>`, `permalink` the issue's link (left out when there is none); Harvest keeps and returns them, and shows the permalink on the entry.
   - If passes: nothing changes.
   - If fails: if `permalink` is required, an entry with no link is filed with the notes alone; if `account_id` must be one the tracker knows, send the tracker's own site (for example the Jira host); if Harvest ignores the reference on update, the header line of the notes still names the issue.
9. **Notes**: free text.
   - Current: `[KEY] title`, then a blank line and the comment; an update keeps the header it reads from the entry and replaces the rest; a reader strips it back to the comment. Titles are one line, at most 200 characters.
   - If passes: nothing changes.
   - If fails: if Harvest limits notes or strips the first line, the issue is still read from `external_reference.id`; if it rewrites newlines, the comment separator becomes ` - `.
10. **No idempotency key**: the same POST twice makes two entries.
    - Current: capabilities say `idempotency: local`; the engine sends one entry at a time per sink and the period reconciliation finds a duplicate left by a create whose answer was lost.
    - If passes: nothing changes.
    - If fails: not a service check; if Harvest ever honours a key header, set `native` in the capabilities and the catalogue.
11. **Rate limit**: 100 requests per 15 seconds per account; 429 with `Retry-After`.
    - Current: a 429 waits `Retry-After` seconds (15 s without the header); the probe reports `perHour: 24000` with origin `typical`; creates and updates make one extra call (`/company`, and a read before an update).
    - If passes: nothing changes.
    - If fails: if the limit is per token or per IP rather than per account, say so in the docs; if `Retry-After` is absent, the 15 s default stands; if the extra calls matter, cache the account mode per connection.
12. **Paging**: `page`, `per_page` (up to 2000) and `next_page` in the body.
    - Current: pages of 100, `next_page: null` at the end, at most 50 pages a list; the feed's page token carries the page and the `updated_since` of the pass.
    - If passes: nothing changes.
    - If fails: if `next_page` is missing, follow `links.next`; if lists change under offset paging and skip rows, the overlap and the reconciliation catch them.
13. **Own entries only**: an administrator or manager's `GET /time_entries` holds everyone's.
    - Current: every read passes `user_id` of the connection's account (the id `GET /users/me` returned).
    - If passes: nothing changes.
    - If fails: if `user_id` is refused for non-administrators, drop it for them and filter on `user.id` of each row.
14. **Deleting**: `DELETE /time_entries/{id}` answers 200 with an empty body; an entry already gone answers 404.
    - Current: both are a success.
    - If passes: nothing changes.
    - If fails: a 204 is already a success; an error body on 200 would be a `ProviderError`.
15. **Deactivated users and contractors**: `users/me.is_active`.
    - Current: an inactive user is `forbidden` at verify; contractors are treated like members (they see only their assigned projects, as a member does).
    - If passes: nothing changes.
    - If fails: narrow the probe's capabilities (for example no `billable` read) for contractors.

## Toggl Track (built on a simulator, not verified on a real account)

The Toggl Track sink (`api/providers/toggl/`, status `experimental`) was written from Toggl's API v9 documentation and tested against an in-process simulator (`simulator.ts`) that models the traps below as documented. None of it has met a real account. Each assumption is checked on a real account (a free workspace, and a paid one with a locked period and "require project" on) before the adapter leaves `experimental`; until then **Current** holds. Move these into `docs/dev/spikes.md` when the sink is merged.

1. **Authorization**: the personal API token as Basic auth.
   - Current: `Authorization: Basic base64("<token>:api_token")`; a wrong token answers **403** (not 401) with a plain-text body ("Incorrect username and/or password"); an empty 403 body is also read as bad credentials, a 403 whose text says "lock" as a lock, any other 403 as forbidden.
   - If passes: nothing changes.
   - If fails: if a wrong token answers 401, nothing changes (401 is auth already); if a 403 for a locked entry or a missing permission carries text that matches the credentials words, narrow `refused` in `client.ts`.
2. **Hourly quota and 402**: free plan 30 requests an hour per user; over it Toggl answers 402.
   - Current: 402 whose body says "hourly limit" (or `X-Toggl-Quota-Remaining: 0`) is a `rateLimit`; the wait is `Retry-After`, else `X-Toggl-Quota-Resets-In` (seconds), else "in N seconds" in the text, else an hour. A 402 that is not about the quota (a feature the plan lacks: tasks) is `forbidden`. 429 is a `rateLimit` with `Retry-After`, else 60 s. Paid budgets: 240 an hour on the lowest paid plan, 600 on Premium; the probe reports 240 for any paid workspace (`premium: true`) and 30 otherwise, origin `typical`.
   - If passes: nothing changes.
   - If fails: if the quota answers 429, nothing changes; if the headers are named differently, change `waitMs`; if the plan can be read (`pricing_plan_id`, organization), make the probe tell Starter from Premium and mark the figure `detected`; if the free budget is per workspace or organization rather than per user, say so in the docs.
3. **Entry shape**: a start and a `duration` in seconds; a running timer has a negative duration (minus its start as a Unix timestamp) and `stop: null`.
   - Current: create sends `start` (RFC 3339 UTC, whole seconds), `duration` (positive), `created_with: "inkledger"`, `workspace_id` equal to the URL, `description`, and `project_id`, `task_id`, `billable` only when set; no `stop`. Reading skips any entry with a negative duration or no stop.
   - If passes: nothing changes.
   - If fails: if `created_with` or `workspace_id` is not required, drop it; if a positive duration without `stop` makes a running entry, send `stop` too; if a timer's duration is encoded differently, keep skipping on `stop === null`.
4. **Changing an entry**: bulk `PATCH /workspaces/{wid}/time_entries/{id}` with JSON-patch `replace` operations, answered 200 with `{ success: [ids], failure: [{ id, message }] }`.
   - Current: the adapter reads the entry (`GET /me/time_entries/{id}`), refuses a running timer, then replaces `/start`, `/stop`, `/duration`, `/description` (and `/billable` when set) together, because a duration alone leaves the stop where it was; it builds the answer from the entry it read, so a change costs two requests. A `failure` is read by its text: "lock" is a conflict, "not found" a not-found, else invalid. PUT is not used, since it may clear the project and task the call does not know.
   - If passes: nothing changes.
   - If fails: if the paths are not accepted, or `/stop` is refused, send what the service takes; if PUT with only the sent fields keeps the project and task, use it (one request, and the answer is the entry); if PATCH answers 207 or 4xx for a failure, read that.
5. **Deleting**: `DELETE /workspaces/{wid}/time_entries/{id}`.
   - Current: 200 with an empty body on success; an entry that is not there (or deleted already, or in another workspace) answers 404, which is a success; a locked period answers 403 with a text that says "lock".
   - If passes: nothing changes.
   - If fails: if a second delete answers 200, nothing changes; if a locked period is a 400, read its text in `refused`.
6. **Reading a period** (`GET /me/time_entries?start_date=&end_date=`).
   - Current: asked in RFC 3339 instants (the user's day start and end, a second wider on each side), because a bare date is read as UTC; the answer is cut to the days asked, by the user's zone, after. End is exclusive. Spans every workspace of the user: only the connection's is kept. Not paged: it answers at most 1,000 entries with no sign of more, so an answer at 1,000 is read again in halves (until two minutes). The range is at most three months: longer ones are read in pieces of 89 days.
   - If passes: nothing changes.
   - If fails: if bare dates are read in the profile's zone, nothing changes (instants are exact); if end is inclusive, nothing changes (the cut absorbs it); if the cap differs, change `ENTRIES_CAP`; if the response says it was truncated (a header, `meta`), use that instead of guessing; if the range limit differs, change `MAX_RANGE_DAYS`; if a `before` pivot pages the list, page with it.
7. **The feed** (`GET /me/time_entries?since=<unix seconds>`).
   - Current: `since` is in **seconds** (milliseconds are refused with 400), not older than three months (the 7-day window is inside it), and it lists entries changed since, deleted ones included with `server_deleted_at`; the adapter drops those (a window feed reports no removals) and the engine finds them by reconciliation. One answer, no pages; the checkpoint is the pass's start less a minute.
   - If passes: nothing changes.
   - If fails: if `since` ignores edits (only creations), drop the feed to the period read on a timer; if deleted entries are not sent, nothing changes; if the cap applies here too, read the window in halves by `start_date`.
8. **Projects** (`GET /workspaces/{wid}/projects?active=true&page=&per_page=200`).
   - Current: `per_page` is 151 by default and 200 at most; an empty list is JSON `null`; the `name` filter is not used (assumed exact), the active projects are matched here by part of the name, ignoring case, up to five pages (1,000 projects, then `complete: false`). Targets are projects only; a target with an ancestor is read as a task (project is its last ancestor).
   - If passes: nothing changes.
   - If fails: if `name` matches parts of names, send it and save requests on large workspaces; if `per_page` goes higher, raise it; if a page past the end answers an error, stop at a short page (it does already).
9. **Billable and tasks by plan**: billable rates and tasks are paid features.
   - Current: the free plan refuses `billable: true` with 400, and a `task_id` with 402; the probe narrows billable to read-only for a workspace that is not `premium`. Billable is only sent when the worklog sets it.
   - If passes: nothing changes.
   - If fails: if the free plan accepts billable, drop the narrowing; if tasks are on the free plan, add task search to `targets`; if `premium` is not the right flag, read the workspace's plan another way.
10. **Required fields and locks**: a workspace may require a project, a task or a description, and may lock entries before a date; approved timesheets lock too.
    - Current: the requirement is a 400 with Toggl's text, shown as is (`invalid`); the adapter does not read `GET /workspaces/{wid}/time_entry_constraints` first, since each request counts against 30 an hour. A lock is a 403 on create and delete and a `failure` in the bulk answer, read as `conflict` when the text says "lock". An approved timesheet is assumed to refuse the same way; entries are never marked locked on reading.
    - If passes: nothing changes.
    - If fails: if the constraints can be read cheaply, read them in `probe` and narrow the target to required; if locked entries are marked in the entry (a `locked` flag), set `locked` and `editable` on reading; if the refusal has another status or text, extend `refused` and `patchFailure`.
11. **Description**: where the issue is named, at most 3,000 characters.
    - Current: `[KEY] Title — comment`; a " — " inside the title becomes " – " and a "]" in the key ")" so the note reads back exactly; over 3,000 characters the comment is cut, then the title. A refused length is a 400.
    - If passes: nothing changes.
    - If fails: if the limit differs, change `MAX_DESCRIPTION`; if newlines or the em dash are altered by Toggl, change `SEP`; if descriptions are trimmed or HTML-escaped, change the format.
12. **No idempotency**: the same POST twice makes two entries.
    - Current: `idempotency: "local"`; the key is not sent; the engine retries a create only when a read shows the first did not land.
    - If passes: nothing changes.
    - If fails: if Toggl dedupes (a client-side id, `external_id`), declare `native` (a catalogue change) and send the key.

## Tempo (Jira) (built on a simulator, not verified on a real account)

The adapter (`api/providers/tempo/`, status `experimental`) was written from Tempo's REST API v4 documentation and run only against `tempoSimulator()`, which models the traps below as documented. Nothing here has touched a real Tempo Cloud account. Each assumption stays open until it is checked on one (ideally two: a plan with Timesheets and approvals, and one without); **Current** holds until then. The rows `tempo-updated-from` and `tempo-rate-limit` also sit in the table "Still to run" of `docs/dev/spikes.md` and keep their place there.

| Id | Current | If it passes | If it fails |
| --- | --- | --- | --- |
| tempo-auth | `Authorization: Bearer <personal API token>` on every call; a bad token is a 401 (`auth`); the token is made in Tempo, Settings, API integration, and has the rights its scopes give | as is | the header or the scope handling changes in `client.ts` |
| tempo-verify | Tempo has no "who am I": `GET /worklogs/user/{accountId}?limit=1` proves the token and the account id together; the name shown is `Tempo account <id>` | as is | a user or schedule endpoint answers the account's name; `verify` reads it |
| tempo-account-id | The author of every worklog is the user's Jira account id (`authorAccountId`), from the options (`accountId`), else the connection's remote account; `jiraConnectionId` only records which Jira connection it came from | as is | the id is read from Jira at connect time and stored in the options (the core's job) |
| tempo-region-base | One API root, `https://api.tempo.io/4`, serves every Tempo Cloud account (no region host, no site name) | as is | a per-region root is asked for in the connect form (`TOKEN_FORMS.tempo.apiBase` becomes null) |
| tempo-issue-id | The issue is `issueId`, the Jira issue's numeric id (a JSON number), never its key; the ExternalRef's `issue.remoteId` is that id; a key is refused before the call and an unknown id is a 400 | as is | a string id or the key is accepted: widen `issueIdOf` |
| tempo-two-ids | A worklog has `tempoWorklogId` (every Tempo call takes it; the entry's `remoteId`) and `jiraWorklogId` (its mirror in Jira, a different number, a 404 on Tempo's calls); the Jira id is kept in the entry's `version` as `<updatedAt>#jira=<id>` and read with `jiraWorklogIdOf` | as is | `jiraWorklogId` is absent on some reads (older worklogs, async mirroring): the helper answers null and the core falls back to matching by issue, start and seconds |
| tempo-user-zone | `startDate` and `startTime` are the Jira user's wall clock in their profile time zone, no offset; the connection's zone (the user's) is taken to be the same one; an instant goes out as that wall clock and comes back as the same instant | as is | the profile zone differs from the connection's: read the zone from the Jira user (`/myself`) and keep it in the options |
| tempo-start-time | `startTime` is always sent (`HH:mm:ss`); a worklog read without one counts from 00:00:00; the seconds field is kept | as is | read the default start time of the account's workday instead of midnight |
| tempo-seconds | `timeSpentSeconds` and `billableSeconds` are whole seconds and are sent as they are; no minimum or maximum is declared (`limits: {}`) | as is | the capabilities get an `increment` (60 s) or `maxSeconds` so the core rounds or refuses before calling |
| tempo-minute-rounding | Tempo keeps what the answer says: the adapter reports the seconds in the answer, never the ones it sent (the simulator can round to whole minutes) | as is; no limit needed | a rounding the answer hides (Jira's mirror in minutes only) is read as a limit: `increment: { seconds: 60, rounding: "nearest" }` |
| tempo-billable | `billableSeconds` is the billable part of the time: all of it for `billable: true`, 0 for `false`, left out when unsaid (the service decides); read back, any billable seconds means billable; on a change the stored share is kept when unsaid | as is | billable is an account attribute instead of seconds: read it from the work attributes |
| tempo-put-replace | `PUT /worklogs/{id}` replaces the whole worklog (`issueId` and `authorAccountId`, `startDate`, `timeSpentSeconds` required): the adapter reads the stored worklog first and sends back its issue, attributes, billable share and note head; what is left out would be cleared | as is | `issueId` is optional or ignored on PUT: drop the read-first for the issue; if PATCH-like merging exists, drop the carrying over |
| tempo-note | The worklog's `description` starts with `<KEY>: <title>` on its own line, then the comment; read back, a first line of that shape is the head and the rest the comment, anything else is a comment as it is; the length limit is not known | as is | a length limit on `description`: truncate the title, never the comment |
| tempo-no-idempotency | No idempotency key: a POST sent twice makes two worklogs, so `idempotency: "local"`; the key is never sent | as is | a header or field for it appears: `idempotency: "native"` and the key is sent |
| tempo-no-concurrency | No revision on a worklog (`concurrency: "none"`); `updatedAt` is not an `If-Match` | as is | an `ETag` or version appears: `concurrency: "revision"` |
| tempo-delete | `DELETE /worklogs/{tempoWorklogId}` answers 204; an absent worklog is a 404, read as already gone | as is | a 400 or 403 for a missing id: map it |
| tempo-locked | A worklog in an approved timesheet period can't be created, changed or deleted: Tempo answers 400 with a message that names the approval; the adapter reads a 400 whose message mentions approved, locked or a closed period as `forbidden`; a list marks such worklogs locked (cause `approved`) from the approval periods | as is | the status or the message differs: match on a code in the error, not the text; other locks (closed periods, Jira's own) get their cause |
| tempo-approvals | `GET /timesheet-approvals/user/{accountId}?from=&to=` returns periods `{ period: { from, to }, status: { key } }`; `OPEN` is `draft`, `IN_REVIEW` or `WAITING_FOR_APPROVAL` is `submitted` (still editable), `APPROVED` is `approved` and locks; a day with no period is `none` | as is | the status keys or the period fields differ: adjust `approvalState` |
| tempo-plan-approvals | Approvals belong to Tempo Timesheets plans: a 403 or 404 on that endpoint means the plan has none, and worklogs are listed with no approval known and nothing locked (a refused write still comes back `forbidden`) | as is | the plan check is a different status: map it |
| tempo-work-attributes | `GET /work-attributes` lists attributes; the first of type `STATIC_LIST` (or the one named by the option `workAttributeKey`) is the activity: its `values` are the ids, `names[value]` the display names; a worklog carries `attributes: [{ key, value }]`; a value not on the list is refused before the call | as is | the work type is an account field, not a static list: read it from `ACCOUNT` or `CATEGORY` attributes |
| tempo-required-attribute | A required work attribute that the adapter doesn't fill (any other than the activity) is the service's 400 (`invalid`, with Tempo's message); the activity is `required: "no"` | as is | required attributes are listed by `GET /work-attributes` (`required: true`): the probe declares `required: "input"` when the activity is one |
| tempo-updated-from | `GET /worklogs/user/{accountId}?updatedFrom=<UTC, to the second>&offset=&limit=` filters by change; the feed is a window: the first pass reads 7 days back, a later one from its checkpoint, which is the pass start minus 1 hour; no removals are reported (a deleted worklog is found by reconciling a period) | `feed` stays a window | if `updatedFrom` is a monotonic, persistable watermark, the feed becomes incremental (the Jira worklog id mirror checked alongside) |
| tempo-paging | Lists answer `{ metadata: { count, offset, limit, next? }, results }`; `limit` is 1000 at most (more is a 400); the adapter pages by `next` (a full URL, followed only on the API's own origin) and, in the feed, by offset | as is | the cap or the metadata differs: change `PER_PAGE`, page by `count` |
| tempo-list-range | `from` and `to` on `/worklogs/user/{accountId}` are plain dates, inclusive, in the user's zone; no maximum range is declared | as is | the range is capped (a year?): declare `reconcile: { kind: "period", maxDays }` |
| tempo-own-worklogs | `/worklogs/user/{accountId}` lists the account's own worklogs; other people's worklogs (on behalf) are neither written nor listed; `onBehalf` is read only | as is | the endpoint also needs a permission to see one's own worklogs: a 403 is `forbidden` |
| tempo-timers | The API has no running timers (a Tempo timer ends as a worklog); nothing here depends on one | as is | a timer endpoint appears: the entry is a session without an end, not supported |
| tempo-rate-limit | A 429 is `rateLimit`, waiting for `Retry-After` (seconds or a date), else 60 s; no budget is declared | `typicalRateLimit` with the published figure and its scope (token, user, account) in the limiter's configuration | read the real headers |
| tempo-network | Every call goes through `safeFetch` with `network: "public"` against `https://api.tempo.io/4` | as is | stays |

## Still to run

Each row has a stable id. The provider catalogue (`api/providers/catalog.ts`) marks every value that depends on one as `(verify: <id>)`; a test checks that every marked id has a row here. **Current** is the value held until the spike runs, always the conservative one.

When a spike runs, its row becomes a concluded entry above, recording:
- the date;
- the API version, the plan or account type, and the region or deployment;
- the method (a script or test in the repo);
- the anonymized responses that answer it;
- the decision, and the commit that applies it.

The section gives the status: rows here are pending (or running, said in the row); a spike that passed, failed or was superseded moves above as a concluded entry.

In **Current**, `—` means no implementation choice is enabled before the spike: the dependent work doesn't start until it has run. "No budget declared" doesn't mean no throttling: the adapter throttles from the service's rate-limit errors and headers (`Retry-After`), with its own prudent internal limit where needed, and publishes no figure as a capability.

| Id | Status | Check | Before | Current | If it passes | If it fails |
| --- | --- | --- | --- | --- | --- | --- |
| platform-migration | pending | Full platform migration on a copy of a production dump. Passes: under 60 s with the server stopped, rollback (`pg_restore --clean`) tested | the platform schema migration | — | migrate as planned | split the migration (backfill in the data-migration runner) |
| webview-storage | pending | Android WebView / Tauri: cookie and a localStorage device id survive 3 app restarts, 1 device reboot and 1 app update | local accounts, device buckets | — | device id in localStorage | device id kept by the native shell |
| github-projects | pending | GitHub token from the device login: user-owned Projects v2 status readable and writable | GitHub Projects status | `boolean` source only (open/closed with reason) | fine-grained PAT for project status | classic PAT documented for project status only |
| github-transfer | pending | GitHub: a transferred issue as reconciliation sees it (301, new node id), and how its successor is found | GitHub adapter | gone `transfer: none` (found as `missing`) | `transfer: withSuccessor` | stays `none` |
| gitlab-statuses | pending | GitLab Premium: work item statuses readable and settable through GraphQL | GitLab adapter | `boolean` + `labelSet` | add `itemState` (where the plan has it) | stays `boolean` + `labelSet` |
| gitlab-timelog | pending | GitLab: `timelogCreate` with `spentAt` (an entry on a chosen day); on 13.x, `/spend` notes | GitLab adapter | write: entry, update `recreate`, delete (timelogs, or notes) | nothing changes | back to read only |
| gitlab-rate-headers | pending | GitLab: 429 responses and `RateLimit-*` headers agree | GitLab adapter | — | throttle from headers | throttle from 429 and `Retry-After` only |
| tempo-updated-from | pending | Tempo Cloud: `updatedFrom` as a monotonic, persistable watermark (separate token, Jira worklog id mirror checked alongside) | Tempo | feed window by change, 7 days | feed incremental, no removals | stays a window |
| tempo-rate-limit | pending | Tempo: the published budget and its scope (token, user, account) | Tempo | no budget declared (429 and `Retry-After` only) | `typicalRateLimit` with the figure; scope in the limiter's configuration | stays undeclared |
| clockify-rate-limit | pending | Clockify: the published budget and its scope (token, user, workspace, endpoint) | Clockify | no budget declared | as Tempo | stays undeclared |
| everhour-rate-limit | pending | Everhour: the published budget and its scope | Everhour | no budget declared | as Tempo | stays undeclared |
| plane-worklogs | pending | Plane v2 worklogs: update, delete, plan tier | Plane adapter | update none, no delete | update native, delete | stays |
| asana-status | pending | Asana custom task type status (`completion_state`) readable and settable | Asana adapter | `column` + `boolean` | add `projectField` | stays `column` + `boolean` |
| asana-time-feed | pending | Asana time tracking entries: a change filter, or events reporting them | Asana adapter | feed none, reconciled by period | feed incremental (with removals if events report them) | stays |
| redmine-time-feed | pending | Redmine time entries: an `updated_on` filter through the API | Redmine adapter | feed window by entry date | feed incremental, no removals | stays |
| durable-objects | pending | Cloudflare Durable Objects on the free plan (`new_sqlite_classes`) | licence activation (store) | — | activation store on a Durable Object | the paid plan, or a D1 table with a unique key |

**Webhook payloads** have no row yet: every catalogued webhook is a `signal` (the conservative value), and webhooks are the last provider work (D5). When a provider's webhooks are built, each of its events gets its own row, `webhook-<provider>-<event>`, before it may be declared `full`.

**Rate limit scope** stays out of the contract: a `RateLimitFigure` says how much, and the scope (which token, user, workspace or endpoint shares it) is the rate limiter's own configuration per adapter. The contract changes only if an adapter shows the engine can't throttle correctly without it.
