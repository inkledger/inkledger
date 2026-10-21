# Clockify

Status: **experimental**. The adapter was built against a simulator written from Clockify's public API documentation (API v1) and has not met a real account yet (see [What is not verified yet](#what-is-not-verified-yet)). Until you allow writes on the connection, it only reads.

Clockify is a **time sink**: it receives time, it is not an issue tracker. Every worklog you log in inkledger is also filed there, in the background, after the fact.

## What inkledger sends

- **One finished time entry per worklog**: a start and an end, as UTC instants to the second (`2026-10-14T08:30:00Z`). A worklog logged at 08:30:00.750 for 90 seconds becomes 08:30:00 to 08:31:30.
- **The issue in the note.** The description's first line is `[KEY] issue title`; what you wrote as the comment follows on the next lines. A description is at most 3000 characters in Clockify: a longer comment is cut, and the first line is always kept. Clockify has no field for an external issue reference, so the note is how an entry points back at its issue (and how inkledger knows, when it reads entries back, which issue they were for).
- **A project or a task**, when the issue's container is mapped to one in inkledger (Settings, time sinks) or the connection has a default. A task is sent with its project. If your workspace **forces projects** (or tasks), an entry without one is refused by Clockify and the worklog is marked as failed on that sink with Clockify's words; map a project or task and it goes through.
- **Billable**, only when inkledger says so; otherwise Clockify applies the project's own setting.
- **Changes and deletions.** A changed worklog updates its entry; a deleted one deletes it. Clockify replaces an entry whole when it is saved, so inkledger first reads it and sends the project, task, tags and billable flag back unchanged. The note's first line is kept; the comment is replaced.
- **For someone else** (an entry on a colleague's name) only when you ask for it and the key belongs to a workspace admin; for anyone else Clockify answers forbidden.

Not sent: tags, custom fields, rates, running timers, and anything about approving or invoicing.

## What inkledger reads

- **Your own entries of a period**, to reconcile (Clockify has no change feed). A day is counted in the time zone of the connection, so an entry at 23:30 stays on its day. The days the clocks change (23 or 25 hours) are handled.
- **A running timer is not an entry**: it has no end yet and is left alone. It appears when you stop it.
- **Locked entries.** Entries in an approved or submitted timesheet, or in a locked period, cannot be changed: they are shown as locked and inkledger does not try. Whether a lock is an approval or a closed period can be told apart only when the key may read approval requests (a workspace admin or manager); for anyone else every lock reads as a closed period.
- Targets: **projects by name** (archived ones left out) and, for the first five projects that matched, their **active tasks**. Clockify cannot search tasks across projects, so type the project's name to find its tasks.

## Token

Clockify uses a personal **API key**. Make it in Clockify: your profile (top right), Preferences, **Advanced**, "API" section, "Generate". Paste it into the connection form. inkledger sends it in the `X-Api-Key` header and never in a URL. The key has the access of your account.

The **workspace** is the one marked active for you in Clockify unless the connection's options name another one: `{ "workspaceId": "<24 hex characters>" }`. The id is in the address when you open the workspace's settings. There is no screen for this yet.

## Limits

Clockify allows **50 requests per second** per key. Over it, it answers 429; inkledger waits as long as `Retry-After` says, or a second when it says nothing. No budget is declared as a capability until the figure and its scope are checked (spike `clockify-rate-limit`); the connection's probe reports the 50 as a typical figure.

Clockify does not honour an idempotency key: sending the same create twice makes two entries. inkledger therefore only retries a create when it has first read the period and seen that the first did not land.

## Self-hosted

Clockify is a hosted service only (regional endpoints, such as the EU one, are not offered yet). The connection's API base is `https://api.clockify.me/api/v1`.

## What is not verified yet

Everything above is from the documentation. In particular, not checked on a real account: the exact filter semantics of `start` and `end` on the entries list (whether `end` bounds the start or the end of an entry), the page size ceiling, the status and body of a locked-entry refusal, what Clockify answers for an entry that is gone, how approval requests are read (and who may), whether a workspace-forced project or task is refused with a 400, how a description over 3000 characters is handled, the rate-limit answer, and entries for another user. See `api/providers/clockify/SPIKES.md`.
