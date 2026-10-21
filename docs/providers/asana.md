# Asana

Status: experimental. The adapter was built against a simulator written from Asana's public REST API 1.0 documentation; it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "Asana".

## What inkledger reads

- **Tasks assigned to you**, in every workspace the token sees (or the one named in the connection's options). A first read takes the open tasks and those completed in the last 30 days; later reads take every task modified since the last one.
- Each task is keyed `ASANA-<gid>`. Asana tasks have no number of their own, only a long numeric id (a gid, kept as text: it is larger than 2^53), which never changes when a task moves between projects. A web link of a task (`app.asana.com/0/<project>/<task>`, `/0/0/<task>`, `/1/<workspace>/project/<project>/task/<task>`) is understood wherever a key is.
- For each task: title, link, container (the task's first project, else its workspace; a subtask takes its parent's project), status, tags (as labels), assignee, creator, parent, start and due date, spent time, and the dates it was created, modified and completed. A due date with a time is shown on your own day, not UTC's.
- **Status**: Open or Completed, and, when the connection's options name sections (`columns`, a map from section name to category), the section the task sits in. Asana does not say what a section means, so only the sections you list are statuses; the category is never guessed from the name.
- The description and the **comments** (Asana's HTML; system stories like "moved this task" are history, not comments), and the task's **history** (completion, section, name, due date and assignee changes).
- **Time tracking entries** of a task: day, whole minutes, note, billable status, category, approval state. Entries in a submitted or approved timesheet, and other people's, are read-only.
- Text search over your tasks (the search endpoint on paid plans, typeahead on free ones).

## What inkledger writes

- Complete / reopen a task; move it to another section of its own project (only sections you gave a category).
- Comments, from Markdown to the few tags Asana accepts (bold, italic, strike, code, links, lists). Headings, quotes, code blocks, tables and images are written as plain text, and the app says so.
- Following and unfollowing a task.
- Time tracking entries: create, change, delete, on a day, in whole minutes (a duration is rounded to the nearest minute, at least one), with a billable status and a category.

Writes are off for this connection until you allow them (the adapter is not verified yet).

## Token

Create a personal access token in Asana: profile photo, Settings, Apps, Manage Developer Apps, Personal access tokens, Create new token. It has your own access. Paste it as is; inkledger sends it as `Authorization: Bearer <token>`. Asana personal tokens have no scopes. Time tracking and search need a paid plan; on a free plan their calls answer 402, which inkledger reports as forbidden (search falls back to typeahead).

## Limits

Asana limits requests per minute by plan (about 150 on free, 1,500 on paid) and the number of simultaneous requests; a refused request answers 429 with `Retry-After` in seconds, which inkledger waits out. Asana sends no budget headers, so no figure is shown. Lists are read 50 tasks per page with the `offset` token Asana returns; a token Asana no longer takes restarts the read.

## Self-hosted

Asana is a hosted service only. The connection's API base is `https://app.asana.com/api/1.0`.

## Webhooks

The adapter has the verification Asana documents: creating a webhook is a handshake (Asana sends `X-Hook-Secret`, the receiver echoes it with 200), and every delivery is then signed in `X-Hook-Signature` (hex HMAC-SHA256 of the raw body under that secret). Deliveries have no id; their age is the latest event's time. Webhooks are not wired yet: syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular: the `GET /tasks` filters, what `opt_fields` the nested paths accept, time tracking entries (fields, `billable_status`, approval, the category endpoint), the error shapes, the rate limits, the webhook payloads, and how tasks deleted or removed from your list are reported. See the spikes.
