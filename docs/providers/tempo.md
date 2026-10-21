# Tempo (Jira)

Status: experimental. The adapter was built from Tempo's REST API v4 documentation against a simulator and has not been run on a real Tempo Cloud account (see "Not verified yet"). Writes stay off until you allow them on the connection.

Tempo is a time sink: it only receives time. It does not give inkledger issues; the issues come from your Jira connection, and every worklog you log is also filed in Tempo.

## What inkledger sends

- **A worklog per worklog of yours**, on the Jira issue named by its **id** (Tempo takes `issueId`, never the key), with the start (`startDate` and `startTime`, your wall clock in your time zone), the duration in seconds and the author (your Jira account id).
- **The note** always starts with the issue's key and title on its own line (`PROJ-12: Login fails on Safari`), followed by your comment. When inkledger reads a worklog back it drops that first line.
- **Billable**: `billableSeconds` is the whole duration when the worklog is billable, 0 when not. Left unsaid, Tempo decides. When a worklog changes, its billable share is kept.
- **Activity** (a Tempo work attribute of type static list, such as Work type): sent as the worklog's attribute. The first static list of your account is used, or the one named by the option `workAttributeKey`.
- **Changes** are sent as a whole worklog (Tempo replaces it): inkledger first reads the stored worklog and sends back its issue, attributes and the head of its note. **Deletions** are by the Tempo worklog id.

Tempo has no idempotency key: a worklog sent twice would be two worklogs, so inkledger only retries what a read shows did not land.

## The two ids of a worklog

Tempo replaces Jira's own worklogs: each Tempo worklog also appears in Jira under another number (`jiraWorklogId`). inkledger's entry is the Tempo id (`tempoWorklogId`, the one every Tempo call takes). The Jira id is kept with the entry (its version, `<updatedAt>#jira=<id>`) and is read with `jiraWorklogIdOf`, so the two views of one worklog can be kept as one.

## What inkledger reads

- Your worklogs of a day range (`/worklogs/user/{accountId}`), and the ones changed lately: a window feed by `updatedFrom` (7 days back at the first pass, then from the last checkpoint minus an hour). Deleted worklogs are not reported by the feed; a period is read again to find them.
- **Approvals**: for the days read, your timesheet approval periods. A worklog in an approved period is shown as locked (approved) and cannot be changed; a submitted one is still editable. A plan without Tempo Timesheets has no approvals: worklogs are then listed with no approval known, and a write that Tempo refuses for an approved period is reported as not allowed.
- Your activities (the values of the work attribute, with their names).

## Token and where to make it

Tempo Cloud, as an admin or as yourself: **Tempo, Settings, API integration, New token**. Give it a name and the scopes to read and manage worklogs (and to read timesheet approvals if your plan has them). Paste the token into the connection; the API address is `https://api.tempo.io/4` for every account. The token acts with the rights of its scopes, not of a Jira login.

The connection also needs your **Jira account id** (the long id Jira gives you, like `5b10ac8d82e05b22cc7d4ef5`) and the Jira connection it belongs to; these are filled from the Jira connection and are not secrets.

## Not verified yet

Everything. `api/providers/tempo/SPIKES.md` lists each assumption with what happens if it holds or not. The ones most likely to matter:

- that the time zone of your Jira profile is the one of the connection (the start is a wall clock with no offset);
- that `PUT` needs the issue id and clears what is left out (inkledger reads and sends everything back);
- the exact message and status of a refusal for an approved period (a 400, told apart by its text);
- whether `updatedFrom` can carry a real checkpoint (today it is a window), and the published rate limit (none is declared; a 429 waits for `Retry-After`);
- the work attribute used as the activity, and any other attribute your account marks as required (Tempo then refuses the worklog with its own message).
