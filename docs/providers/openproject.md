# OpenProject

Status: experimental. The adapter was built from OpenProject's API v3 documentation against a simulator and has not been run on a real server (see "Not verified yet").

## What inkledger reads

- **Work packages assigned to you** (`assignee = me`), changed since the last sync, closed ones included. Work packages in projects you cannot see are never listed. One that is no longer assigned to you simply stops being listed (it is found by reconciliation, not reported).
- For each work package: key (`#123`), subject, project, type, status, priority, assignee, author, due date, estimated time and spent time, created/updated, and a link back to OpenProject. Spent time is empty where the project has no time tracking.
- The description and the comments (Markdown, shown as CommonMark).
- The statuses of the instance and the ways out of the current status, as OpenProject's form offers them to you.
- The history of a work package (see "Known behaviours").
- Your time entries (and, where you may see them, those of others on work packages you open).

## What inkledger writes

- **Time entries**: a day, a duration, a comment (at most 255 characters, OpenProject's limit), optionally an activity and another user ("on behalf", which needs the right to log time for others). Who logged an entry cannot be changed afterwards.
- **Status changes**: to a status the workflow of the work package's type and your role allows. OpenProject may still refuse one (a required field, for instance); its message is shown.
- **Comments** (Markdown) and **watching** a work package.

Nothing else is written. inkledger does not create, edit, assign or label work packages in OpenProject, and does not read your in-app notifications.

## Keys

A work package is `#123`: the number is its id, unique on the instance and unchanged when the work package moves to another project. Pasted links work too: `/work_packages/123`, `/projects/<project>/work_packages/123/activity`, `/work_packages/details/123/overview`, `/wp/123`, `/notifications/details/123` and the API's own `/api/v3/work_packages/123`.

## Status categories

OpenProject only says whether a status closes the work package. inkledger maps: closed is `done`, or `cancelled` for names such as Rejected, Duplicate, Obsolete; open is `doing` for names such as In progress, Developed, In testing, In corso, otherwise `todo`. There is no `triage` or `backlog`. Your own mapping per connection can override these.

## Token and permissions

Make a **personal API token**: avatar menu, My account, Access tokens, API, "+ API token" (older versions: My account, Access token, API). The token is shown once. inkledger sends it as HTTP Basic auth with the user name `apikey`, as OpenProject documents. An administrator must have the API enabled (Administration, API and webhooks).

The account behind the token needs, per project: view work packages, add comments, edit work packages (to change a status), add or remove watchers, and for time: view time entries, log time, edit own time entries (plus "log time for other users" for entries on behalf). Without the right OpenProject answers 403, which inkledger shows as a missing permission; a project where the time tracking module is off cannot take time at all.

Connect with the instance's address:

- **OpenProject Cloud**: `https://<name>.openproject.com`.
- **Self-hosted**: the address you open in the browser, with its context path if the instance is installed under one (`https://tracker.example.com/openproject`); `/api/v3` is added when missing. A private address is allowed for a self-hosted server. Use https.

## Webhooks

OpenProject can POST to inkledger when a work package, a comment or a time entry changes (Administration, API and webhooks, Webhooks). Give the webhook a **secret**: OpenProject then signs each body with it (`X-OP-Signature: sha1=<HMAC-SHA1>`), and inkledger accepts only signed deliveries (a webhook without a secret is refused). Deliveries carry no id or send time of their own: inkledger takes the id from a hash of the body and the time from the item's `updatedAt`. A delivery is only a signal: inkledger reads the work package again.

## Options

- `excludeProjects`: project identifiers (the slug in a project's address) left out of the sync.

## Known behaviours

- Collections are paged by page number, and the server may cut the page size; inkledger reads the size the answer reports. Work packages are read in id order, so an edit during a sync cannot make it skip one.
- Time entries change under a revision: where the entry carries a `lockVersion` it is sent back and a stale one is a conflict; otherwise inkledger compares the entry's update time before it writes (a small window remains).
- The history of a work package is OpenProject's journal rendered as sentences in your language ("Status changed from New to In progress"). The English sentences are read apart into field, before and after; any other language is kept whole as the change's text.
- Priorities have no portable rank here: they are shown by name.
- Comments on a work package, its changes and commits share one list; inkledger reads only the comments.
- A work package the token cannot see or that was deleted is "not found", the same for both.

## Not verified yet

Everything. `api/providers/openproject/SPIKES.md` lists each assumption with what happens if it holds or not. The ones most likely to matter: the `updatedAt` filter on work packages and time entries (and its blank upper bound), whether time entries carry a `lockVersion`, the form's allowed statuses and activities, what lists embed, the subject search filter, how the journal's details read in other languages, the webhook headers, and the rate limit headers.
