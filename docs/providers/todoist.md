# Todoist

Status: experimental. The adapter was built against a simulator written from Todoist's public documentation (the unified API v1 and its Sync API); it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "Todoist".

## What inkledger reads

- **Tasks assigned to you**, in every project you belong to, plus the tasks nobody is assigned to in your own, unshared projects (your Inbox among them). A task unassigned in a shared project is nobody's and is not read. Completed tasks show up once they change after the first read.
- Each task is keyed by its **id**, an opaque string (Todoist has no display key). The id stays when the task moves to another project or section. A pasted link (`https://app.todoist.com/app/task/<title>-<id>`) or an old `showTask?id=<number>` link finds the task; old numeric ids go through Todoist's id mapping.
- For each task: title, link, labels (names), priority (Todoist's "p1" is urgent; "p4", the default, is read as none), assignee, who added it, due date, deadline, whether it recurs, its parent task, and the dates it was added, last updated and completed.
- **Due dates.** A date or a time without a zone counts on your own clock, so its day is the day shown. Only a time fixed to an instant (stored with a time zone) is moved to your time zone, the one set on the connection.
- **Status.** A completed task is "Completed"; an open task is the section it sits in; an open task with no section is "Open". Todoist gives sections no meaning, so their category (backlog, todo, doing, done, cancelled) comes from the connection's own mapping. See "Categories".
- The description and the **comments** (Markdown), and the task's **history** (title, description, due date, assignee, completed and reopened), from Todoist's activity log. Todoist keeps that log for a week on the free plan and longer on paid ones, so older changes are absent.
- Text search across the open tasks you can see.
- A deleted task is reported as deleted. A task reassigned to someone else is not told apart from any other change: it just stops coming.

## What inkledger writes

- Completing a task and reopening it. Completing a recurring task moves it to its next date and leaves it open, as in Todoist; inkledger shows the task as Todoist then has it.
- A move to another section of the task's project, or out of every section.
- Comments, as Markdown.

Nothing else is written. Time is not sent to Todoist: it stays in inkledger's own register.

## Categories

A connection's options hold `categories`: the category of each section, by section id or by section name (any case). For example `{ "Doing": "doing", "Done": "done", "Won't do": "cancelled" }`. A section nobody mapped is read as `todo`. An id wins over a name. Completed is always `done` and a task with no section `todo`. There is no screen for this yet.

## Token

Make a personal API token in Todoist: Settings, Integrations, Developer, "API token". It has the access of your account (reading and writing); there are no narrower scopes for a personal token. Paste it into the connection form. inkledger sends it in the `Authorization: Bearer` header and never in a URL.

## Limits

Todoist allows 450 requests per 15 minutes per user. Over that it answers 429 with the number of seconds to wait in the body; inkledger waits that long and tries again. A pass costs one Sync call, the project list and, when tasks sit in sections, the section list; names of other people come from a project's collaborators.

## Self-hosted

Todoist is a hosted service only. The connection's API base is `https://api.todoist.com`.

## Webhooks

The adapter has the verification Todoist documents (`X-Todoist-Hmac-SHA256`, the base64 HMAC-SHA256 of the raw body under the **client secret** of a Todoist app), but webhooks are not usable yet: Todoist webhooks belong to an app registered in the developer console and fire for the users who authorized it, and a personal token cannot register one. Syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real account: the base path and Bearer scheme, the Sync API call shape (JSON body, `resource_types`) and what an incremental sync returns for completed, deleted and reassigned tasks, how an unknown sync token is treated, the Sync API's item read for completed tasks, the id mapping, the exact page limits, how a task is moved out of a section, what completing and reopening do to sub-tasks, recurring tasks and sections, the shape of the activity log and its retention, the characters a search must escape, rate-limit answers, and the webhook signature. See the spikes.
