# Redmine

Status: experimental. The adapter was built from Redmine's REST documentation against a simulator and has not been run on a real server (see "Not verified yet").

## What inkledger reads

- **Issues assigned to you** (`assigned_to_id=me`, closed ones included), changed since the last sync. Issues assigned to a group you belong to are not listed (Redmine's `me` is you, not your groups). An issue you cannot see is never listed.
- For each issue: key (`#123`, the issue number, unique on the whole server), title, project (its identifier), tracker, status, priority, assignee, author, parent, start and due date, estimated and spent time, custom fields, created/updated/closed, and a link back to Redmine. Spent time is missing when your account may not see time entries.
- The description and the comments (textile; a journal without notes is history, not a comment). Private notes you can see are listed.
- The statuses of the server and the ways out of an issue's current status (Redmine 5.0 or later; see below).
- The history of an issue (status, assignee, project and other attribute changes, custom fields, attachments, relations), with ids turned into names where Redmine lets a user read them.
- Your time entries of the last 30 days (and those of an issue you open, whoever logged them).

## What inkledger writes

- **Time entries**: a day, a duration, a comment, an activity (the server's default when none is chosen) and, where you may, another user ("on behalf"). Redmine keeps hours to two places: durations are rounded to 36 seconds (an entry shorter than 18 seconds is refused). A comment is at most 1024 characters.
- **Status changes**: the statuses the issue's workflow allows next. A workflow that demands a field is refused with Redmine's message.
- **Comments**: sent as paragraphs (the text unchanged); Markdown that textile would show differently is reported as approximated. Redmine answers a comment with nothing, so the comment appears at the next read.
- **Watching** an issue.

Nothing else is written: inkledger does not create, edit, assign or label issues in Redmine.

## Status categories

Redmine only says whether a status closes the issue. inkledger maps: closed is `done`, or `cancelled` for names such as Rejected, Won't fix, Duplicate, Rifiutato; open is `doing` for names such as In Progress, Resolved, Feedback, In corso, otherwise `todo`. Resolved is open in a default Redmine: it is not `done` until the issue is closed. There is no `triage` or `backlog`.

## Token and permissions

Redmine needs the REST web service switched on (Administration, Settings, API, "Enable REST web service") and, per user, an API access key: **My account, API access key, Show**. Give it to inkledger as a token connection with the address of your Redmine, with its sub-URI if it has one (`https://redmine.example.com`, `https://example.com/redmine`). The key has the rights of your account; there are no scopes. The account needs, per project: view issues, add notes, edit issues (for status changes), view time entries, log time (and edit own time entries), watch issues, and "Log time for other users" (Redmine 4.1 or later) to log on behalf.

## Self-hosted notes

- A private or internal address is allowed (a Redmine is normally self-hosted). Use https.
- Redmine has no rate limit of its own; a proxy in front may answer 429, and inkledger waits for its `Retry-After`.
- If the REST web service is off, or a login page stands in the way, Redmine answers HTML; inkledger reports that the answer is not JSON.
- Comments are read as textile. A server set to Markdown or CommonMark formatting is shown as textile for now.

## Webhooks

Redmine has no webhooks of its own. With a plugin (or a small hook of your own) that POSTs a JSON signal to inkledger, send the connection's secret in the header `X-Inkledger-Secret` and, optionally, a unique `X-Inkledger-Delivery` and a `timestamp` in the body. The secret is compared in constant time, a repeated delivery id changes nothing, and the body is only a signal: inkledger reads the issue again. This header scheme is the adapter's own model, still to verify.

## Known behaviours

- An issue's number never changes, also when it moves to another project: its project (the container) changes.
- The default status filter of Redmine is "open"; inkledger always asks for all statuses.
- Times are UTC to the second and `updated_on` filters are inclusive; each sync re-reads a minute before the latest change it saw.
- Time logged on a project (without an issue) is not read.
- Asking for the entries of an issue also returns its subtasks'; inkledger keeps only the issue's own.
- If you may not log for another user, Redmine silently logs the time for you; inkledger deletes that entry and reports the refusal.

## Not verified yet

Everything. `api/providers/redmine/SPIKES.md` lists each assumption with what happens if it holds or not. The ones most likely to matter: `allowed_statuses` (Redmine 5.0+), the status categories for your workflow, the `updated_on` filter with a time, the time entry change feed, the default activity, logging for other users, the textile/Markdown setting, and the webhook header scheme.
