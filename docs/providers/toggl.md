# Toggl Track

Status: experimental. The adapter was built against a simulator written from Toggl Track's public API v9 documentation; it has not run against a real account. The assumptions to check are listed in `api/providers/toggl/SPIKES.md`.

Toggl is a **time sink**: it receives time and knows no issues. Every worklog you log in inkledger is also filed there, after the fact and in the background.

## What inkledger sends

- One **time entry** per worklog, in the workspace named in the connection: a start (UTC, whole seconds) and a duration in whole seconds. Never a running timer.
- Filed under the **project** the issue's container is mapped to (Settings, Connections, mappings). The project is optional: with none mapped the entry goes in with no project, unless the workspace requires one (then Toggl refuses it and the app shows Toggl's own message).
- A **task** target is supported by the adapter (its project is sent with it) but the search offers projects only: tasks are a paid feature of Toggl.
- The issue is named in the entry's **description**: `[KEY] Issue title — your comment`. Toggl has no field for an issue, so the description is the reference; it is read back from there (the key between the brackets). The comment is cut first if the description would pass Toggl's 3,000 characters.
- **Billable**, when the worklog says so, on a paid plan. On the free plan Toggl has no billable rates: the connection reads billable and never writes it.
- Changes are a bulk `PATCH` of start, stop, duration and description only (and billable when set), so the entry's project, task and tags are kept. Deleting a worklog deletes its entry.

## What inkledger reads

- The entries of the **workspace** in the connection, for a period, to compare with what it filed (reconciliation), and the entries **changed in the last seven days** (a feed by the time of last change). Entries of your other workspaces, of other people, and running timers are skipped. Deleted entries are not reported as removals; a later reconciliation finds them missing.

## Token and workspace

Create your API token in Toggl Track: profile (bottom left), Profile settings, scroll to **API Token**, copy it. Paste it as is: inkledger sends it as Basic auth with the password `api_token`, as Toggl documents. The workspace id is the number in the Track address (`track.toggl.com/<workspace id>/...`) or the one in Organization, Settings. Toggl answers 403 (not 401) to a wrong token; inkledger reports it as a credentials problem.

## Limits

Toggl counts every request against an **hourly quota per user**: 30 on the free plan (the adapter assumes 240 on the lowest paid plan, 600 on Premium; see the spikes). Over the quota Toggl answers 402 with the time left; inkledger waits until the quota resets, which can be most of an hour, and keeps the entries pending. A single worklog costs one request to file, two to change (a read and the patch) and one to delete. Searching projects costs one request per 200 projects. `/me/time_entries` answers at most 1,000 entries without saying more exist: a period that reaches it is read again in halves. A range is read in pieces under three months.

## Not verified yet

Everything above is from the documentation. In particular: the quota figures and the 402 body, the 403 for a wrong token, the bulk `PATCH` paths and answer, whether `name` on projects matches parts of a name, the cap and range limits of `/me/time_entries`, how a locked period or an approved timesheet refuses a write, the description limit, what the free plan refuses (billable, tasks), and whether a workspace that requires a project is told apart before writing. See the spikes.
