# Wrike

Status: experimental. The adapter was built against a simulator written from Wrike's public API v4 documentation; it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "Wrike".

## What inkledger reads

- **Tasks you are responsible for**, in every account the token sees. A first read takes the active and deferred tasks, and those completed or cancelled in the last 30 days; later reads take every task updated since the last one, and ask separately for tasks sent to the recycle bin (those are reported as deleted).
- Each task is keyed `WRIKE-<n>`, where `<n>` is the number in the task's link (`https://www.wrike.com/open.htm?id=<n>`). That number is not the API id: Wrike's API names a task by a 16-character id (`IEAAJKV3KQ…`), which inkledger keeps as the task's remote id and which never changes when the task moves. A pasted task link is understood wherever a key is; the number is converted to the API id with `GET /ids`.
- For each task: title, link, container (the first folder or project it is in, else "No folder"), status, importance (as priority), every person responsible, author, due date, effort estimate, milestone / subtask type, and the dates it was created, updated and completed. A due date is a floating local time with no zone: it shows as the day Wrike prints.
- **Status**: the task's custom status in its folder's workflow. Wrike says what a status means with its group: Active, Deferred (backlog), Completed (done), Cancelled. Active has no further grain, so the first Active status of a workflow, where a task starts, is "to do" and the other Active ones are "doing".
- The description and the **comments** (Wrike's HTML).
- **Timelogs** of a task: day, decimal hours, note, billable or not, category, approval state. Timelogs of other people, and those pending or approved, are read-only.
- Text search over your tasks (the title filter of `GET /tasks`).

## What inkledger writes

- Change a task's status to another status of its workflow (hidden statuses cannot be set).
- Comments, from Markdown to the few tags Wrike keeps (bold, italic, strike, code, links, lists; lines are joined with line breaks). Headings, quotes, code blocks, tables and images are written as plain text, and the app says so.
- Following and unfollowing a task.
- Timelogs: create, change, delete, on a day, in hours kept to two decimals (a duration is rounded to the nearest 36 seconds, at least one step; 24 hours at most in an entry), with a billable flag and a category.

Writes are off for this connection until you allow them (the adapter is not verified yet).

## Token

Create a permanent token in Wrike: your profile, Apps & Integrations, API, "Create new" under Permanent access tokens (Wrike shows it once). It has your own access. Paste it as is; inkledger sends it as `Authorization: bearer <token>`. Wrike's permanent tokens have no scopes.

## Data centers

A Wrike account lives in one data center, and its API answers on that center's host. The connection's API base is `https://www.wrike.com/api/v4` by default; an account on another center (for example `https://app-eu.wrike.com/api/v4`) needs its own base, or its token is refused. Task links are understood only on the host of the connection's base.

## Limits

Wrike limits requests per minute; a refused request answers 429, which inkledger waits out (`Retry-After` when Wrike sends it, else a minute). Wrike sends no budget headers, so no figure is shown. Lists are read 100 tasks per page with the `nextPageToken` Wrike returns; a token Wrike no longer takes restarts the read. Dates sent in filters are UTC to the second (Wrike refuses milliseconds).

## Self-hosted

Wrike is a hosted service only.

## Webhooks

The adapter has the check Wrike documents: each delivery is a list of events and carries `X-Hook-Secret`, the hex HMAC-SHA256 of the raw body under the webhook's secret. Deliveries have no id; their age is the latest event's time. Webhooks are not wired yet: syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular: the exact field names of timelogs (approval state), the `me` and `updatedDate` filters of `GET /timelogs`, the follow / unfollow parameters, how recycle-bin tasks are listed, the webhook handshake and signature header, the answers for forbidden and missing items, and the rate limits. See the spikes.
