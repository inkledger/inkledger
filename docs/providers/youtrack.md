# YouTrack

Status: experimental. The adapter was built from YouTrack's documentation against a simulator and has not been run on a real account (see "Not verified yet").

## What inkledger reads

- **Issues assigned to you** (`for: me`), changed since the last sync. Issues you cannot see are never listed. An issue that is no longer assigned to you simply stops being listed (it is found by reconciliation, not reported).
- For each issue: key (`PROJ-12`), title, project, State, Priority, Type, Assignee, reporter, tags, Due Date, Estimation and Spent time (by their default English names), created/updated, and a link back to YouTrack.
- The description and the comments (Markdown, shown as CommonMark; deleted comments are skipped).
- The states of your projects and the ways out of the current State.
- The history of an issue (State and other field changes, summary, description, tags, project, links).
- Your work items (and, where you may, those of others on issues you open).

## What inkledger writes

- **Work items**: a day, a duration, a text and optionally a work type (activity) and another author ("on behalf"). YouTrack keeps durations in whole minutes: inkledger rounds to the nearest minute (at least one), so a 20-second entry is stored as 1 minute.
- **State changes**: the other values of the project's State, or the events of a state machine. A workflow rule may still refuse a change; its message is shown.
- **Comments** (Markdown) and **starring** an issue (watching).

Nothing else is written. inkledger does not create, edit, assign or label issues in YouTrack.

## Status categories

YouTrack only says whether a State is resolved. inkledger maps: resolved is `done`, or `cancelled` for names such as Won't fix, Duplicate, Obsolete; unresolved is `doing` for names such as In Progress, In corso, otherwise `todo`. There is no `triage` or `backlog`. Your own mapping per connection can override these.

## Token and permissions

Create a **permanent token** in YouTrack: profile menu, Profile, Account Security, New token. Scope: **YouTrack** (the scope that grants the REST API; no Hub or other service scope is needed). The account behind it needs, per project: read issues, add comments, update State, and for time: read and add/update/delete its own work items (plus the permission to update work items of others to log on behalf). Give the token to inkledger as a token connection with the instance's address.

- **YouTrack Cloud**: `https://<name>.youtrack.cloud` (the `/api` suffix is added when missing).
- **Self-hosted (YouTrack Server)**: the address you open in the browser, with its context path if any (`https://tracker.example.com/youtrack`). A private address is allowed for a self-hosted server. Use https.

A request answered as the guest account (a missing or revoked token on a server that allows guests) is refused as a failed login.

## Webhooks

YouTrack does not sign webhooks. To get a refresh signal without waiting for the next sync, add a workflow rule (or an app) that POSTs a small JSON body (`{ "event": "issueChanged", "issue": "PROJ-12", "timestamp": 1790000000000 }`) to inkledger with the connection's secret in the header `X-Inkledger-Secret` and, optionally, a unique `X-Inkledger-Delivery`. The secret is compared in constant time and a repeated delivery id changes nothing. The body is only a signal: inkledger reads the issue again. This header scheme is the adapter's own model, still to verify.

## Options

- `excludeProjects`: project IDs (the `PROJ` part of a key) left out of the sync.

## Known behaviours

- Dates in a query are read in your YouTrack time zone; inkledger asks for a wider window and cuts on the exact `updated` time.
- Lists are paged by offset; an issue changing during a sync is covered by re-reading the last few positions, so it can appear twice in a pass (harmless) but not be skipped.
- A moved issue keeps its internal id and gets a new key; the old key keeps working in YouTrack, and inkledger keeps it as an alias.
- Keys are shown in upper case; lookups are case-insensitive.

## Not verified yet

Everything. `docs/dev/spikes.md`, section "YouTrack", lists each assumption with what happens if it holds or not. The ones most likely to matter: how State categories map for your workflows, state machine events, the work item change feed (`updatedStart`), how a work item's date is stored in your zone, the starring call, the webhook header scheme, and the rate limit headers.
