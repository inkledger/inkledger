# Everhour

Status: experimental. The adapter was built against a simulator written from Everhour's public API documentation; it has not run against a real account. The assumptions to check are in `api/providers/everhour/SPIKES.md` (and the budget in `docs/dev/spikes.md`, row `everhour-rate-limit`). Until you allow writes on the connection, inkledger only reads.

Everhour is a time sink: it receives time and hands none of it to the rest of inkledger as issues. It has no change feed; inkledger reads a period back to reconcile.

## What inkledger sends

- **One total per issue and day.** Everhour keeps one record per user, day and task. After you log, change or delete time, inkledger sets that day's total of the issue to the sum of its own entries of that day (`PUT /tasks/{task}/time`, which replaces). A day left with nothing is set to 0, which removes the record. Sending the same total twice changes nothing, so a retry never counts twice.
- **The task is the issue.** Time is filed on the Everhour task the issue is, named by the integration's prefix and the tracker's own id (`ji:10001` for a Jira issue id, `gh:`, `gl:`, `as:`, `tr:`, `b3:`, `cl:`, `td:`, `wr:`). The issue's project has to be added to Everhour first (Everhour imports its tasks); a task Everhour does not have is refused with a message saying so. Issues of trackers with no Everhour integration (Redmine, YouTrack, Notion…) cannot be filed.
- **A note** on every record: `KEY-12: issue title`, so the record is findable whatever the task shows.
- **Days** are plain dates in your time zone (the one set on the connection), seconds are whole seconds. Never more than 24 hours a day on a task.
- Nothing else: no projects, no tasks created, no timers started or stopped.

## What inkledger reads

- Your own time records for a period (`GET /users/me/time`), to compare with its own. Time of teammates is never read. A record of an Everhour task that is not an issue is listed without an issue. A record in a locked period is shown locked and not editable.

## Not written

- A day with a **timer running** on the same task: the timer adds its time when it stops, on top of the total, so inkledger waits (the entry fails with a "stop the timer" message) until it is stopped.
- A **locked** period (approved time, a locked timesheet): refused as a conflict; inkledger does not unlock anything.

## Key

Make a personal API key in Everhour: My Profile (bottom left), Settings, "Application access", API key. It has the access of your account. Paste it into the connection form. inkledger sends it in the `X-Api-Key` header and never in a URL. The API base is `https://api.everhour.com`; there are no other options (the key says which account).

## Limits

Everhour documents 20 requests per 10 seconds per key; over it, 429 and inkledger waits the time Everhour says. No budget is declared for the connection until it is verified (`everhour-rate-limit`).

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real account: the `/users/me/time` list and its paging (page size cap, `from`/`to` inclusive), whether `PUT /tasks/{task}/time` with 0 removes and what it answers for a record that is not there, whether a task of an integration is created on first use or has to be imported, the task id prefixes of each integration and which id the tracker uses (Jira issue id, not key), the `comment` on a time record, how a locked period is refused (status and wording) and whether the list says so, what a running timer does to a day total, the plan that gives API access, and the rate limit headers. See the spikes.
