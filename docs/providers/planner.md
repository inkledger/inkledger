# Microsoft Planner

Status: experimental. The adapter was built against a simulator written from Microsoft Graph's public documentation (v1.0, `plannerTask` and friends); it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "Microsoft Planner / To Do".

Only **Planner** is read (the tasks of plans, shared with a Microsoft 365 group). **Microsoft To Do** (personal lists, a different API under `/me/todo`) is not read yet.

## What inkledger reads

- **Tasks assigned to you**, on every plan you can see, keyed `PLANNER-<id>`. A Planner task has no number: its id (28 characters, with upper and lower case, `_` and `-`) is its only name, and it never changes. The case matters; only the `PLANNER-` prefix may be typed in any case.
- For each task: title, link, plan (its container), bucket, percent complete, priority, due date, the labels (the plan's names for them; a label nobody named reads as its colour), assignees and the person who created it, and the dates it was created and completed.
- **Status.** Planner has two things that can be one: the percent complete and the bucket. The percent is read as *Not started* (0), *In progress* (1 to 99) and *Completed* (100). A bucket is only free text (people name them "To do", "Review", "Q4"), so it is a status only when the connection's options say what it means (see "Categories"); a completed task reads *Completed* whatever its bucket.
- The **description** (Planner keeps it in the task's details), as plain text.
- Tasks that were **deleted** are reported as such. A task that was unassigned from you, or in a plan you left, is not reported: it leaves your list and inkledger's reconciliation decides what that means.

Planner gives tasks no modification time and no way to ask for what changed. Every pass therefore reads all your tasks and tells the changed ones by their ETag (a revision Planner changes with every change of the task). inkledger keeps a short digest of each in its checkpoint (about 60 bytes a task). Completed tasks older than 30 days are not read. The description, labels' names and bucket names live elsewhere than the task: changing only a description does not change the task's ETag, so inkledger sees it when it reads the description, not in the pass.

## What inkledger writes

- **A move to another bucket** of the task's plan (only buckets that have a category in the options).
- **Start**, **Complete** and **Reopen**, which set the percent complete to 50, 100 and 0.

Nothing else is written. Time is not sent to Planner (it has no time tracking): it stays in inkledger's own register. Comments are not read or written (Planner's comments are Outlook group conversations, not part of the Planner API).

## Categories

A connection's options hold `columns`: the category of each bucket, by bucket name (any case). For example `{ "Doing": "doing", "Review": "doing", "Done": "done", "Won't do": "cancelled" }`. A bucket nobody mapped is not a status: the task reads Not started or In progress. There is no screen for this yet.

## Token

Planner is reached through Microsoft Graph with an **access token** of a Microsoft Entra ID (Azure AD) work or school account, for the delegated permissions:

- `Tasks.ReadWrite` (read is enough to sync; moving and completing need write),
- `User.Read` (who the token belongs to),
- `User.ReadBasic.All` (the names of assignees; without it, they show as ids).

Register an app in the Entra admin center (App registrations), add those delegated permissions under Microsoft Graph, have an admin consent if your tenant asks, and obtain a token for it (the OAuth 2.0 device code or authorization code flow; Graph Explorer's "Access token" tab also shows one for a quick try). Paste the token into the connection form.

An access token lives for about an hour (up to 90 minutes). inkledger cannot refresh a pasted token: when it expires the connection asks to be reconnected with a new one. A long-lived connection needs the OAuth sign-in flow, which this adapter does not bring itself.

Microsoft personal accounts (outlook.com) do not have Planner.

## Limits

Graph throttles per app and tenant and answers 429 with `Retry-After` (seconds); inkledger waits that long (30 seconds when the header is missing) and tries again. A pass reads your tasks 100 at a time, plus, per call, the plan, its buckets, its labels and the assignees once each.

## Self-hosted

Planner is a hosted service only. The connection's API base is `https://graph.microsoft.com/v1.0`. Sovereign clouds (US Government, China) use other Graph hosts and are not supported.

## Webhooks

Not used. Graph change notifications for Planner exist (subscriptions on `/planner/tasks`, with a `clientState` echoed in each notification) but are not wired: they need a public HTTPS endpoint answering a validation token, and subscriptions expire within days. Syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real account: that `/me/planner/tasks` pages by `@odata.nextLink` and returns completed tasks, whether the ETag moves for every change that matters, how due dates are stored by the current apps, the `428`/`412` answers of a change, and which permissions the plan, bucket, details and user reads need. See the spikes.
