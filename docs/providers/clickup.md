# ClickUp

Status: experimental. The adapter was built against a simulator written from ClickUp's public API v2 documentation; it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "ClickUp".

## What inkledger reads

- **Tasks assigned to you**, in every workspace the token sees (ClickUp calls a workspace a "team"; or the one named in the connection's options). A first read takes the open tasks and those closed in the last 30 days (subtasks included); later reads take every task changed since the last one.
- Each task is keyed by its **custom task id** when the workspace has them on (`ENG-123`), else `CU-<id>`, ClickUp's short form of the task id (an alphanumeric id such as `86c0abc12`, kept as text). A custom id is only unique inside a workspace: the same one in two workspaces is reported as ambiguous, never guessed. Web links (`app.clickup.com/t/<id>`, `app.clickup.com/t/<workspace>/<custom id>`) are understood wherever a key is.
- For each task: title, link, container (its home list; the folder is shown as its group), status, tags (as labels), priority, assignees, creator, parent, due date, time estimate and spent time, and the dates it was created, changed and closed. A due date is an instant: it is shown on your own day, whether it has a time of day or not.
- **Status**: statuses belong to a list (a list inherits its space's unless it has its own). Each has a type that gives its category: open is "to do", custom is "doing", done and closed are "done". Nothing is guessed from names.
- The description (read as Markdown) and the **comments** (ClickUp's blocks, shown through a Markdown preview).
- **Time entries** of the workspace: start, duration, note, billable. Running timers are not entries yet and are skipped. Other people's entries are read-only.
- Text search over your tasks. ClickUp's public API has no text search, so the newest 500 of your tasks are matched in inkledger and the app is told when it stopped short.

## What inkledger writes

- A task's status, by name, among those of its own list (any of them: ClickUp has no transition rules).
- Comments, as plain text. Everything beyond paragraphs (emphasis, lists, links, code, headings, quotes, tables, images) is flattened and the app says so.
- Watching and unwatching a task.
- Time entries: create, change, delete, as a start and a duration (whole seconds), with a billable flag.

Writes are off for this connection until you allow them (the adapter is not verified yet).

## Token

Create a personal API token in ClickUp: avatar, Settings, Apps, API Token, Generate. It has your own access; ClickUp personal tokens have no scopes (they start with `pk_`). Paste it as is: inkledger sends it as the whole `Authorization` header, without `Bearer` (that is for OAuth). Time tracking needs the Time Tracking ClickApp enabled in the workspace; without it ClickUp refuses and inkledger reports forbidden (the other workspaces are still read).

## Limits

ClickUp allows 100 requests a minute per token on most plans (1,000 on Business Plus, 10,000 on Enterprise) and says so in `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds). A refused request answers 429 with no `Retry-After`; inkledger waits until the reset. Tasks are read 100 to a page, pages counted from 0.

## Self-hosted

ClickUp is a hosted service only. The connection's API base is `https://api.clickup.com/api/v2`.

## Webhooks

The adapter has the verification ClickUp documents: a webhook created through the API returns a secret, and every delivery is signed in `X-Signature` (hex HMAC-SHA256 of the raw body under that secret). A delivery has no id of its own; the webhook id with its first history item's id stands for one, and the latest history item's date tells its age. Webhooks are not wired yet: syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular: the team task filters (`include_closed`, `subtasks`, `date_updated_gt`, `last_page`), custom task id lookups, the `401` ClickUp answers for a task out of reach, how date-only due dates are stored, comment paging and the block format, the time entry endpoints (window, update answer, billable, `at`), rate limits, and the webhook payloads. See the spikes.
