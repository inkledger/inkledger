# monday.com

Status: experimental. The adapter was built against a simulator written from monday.com's public GraphQL documentation; it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "monday.com".

## What inkledger reads

- **Items assigned to you**, in every board you can see that has a people column and a status column. An item is found by the first people column of its board (the one called `person`, else the first) holding you; teams in that column do not count. Subitems are read from their hidden "Subitems of ..." board, with their parent. Documents, boards without a people or status column, archived boards and boards you cannot open are skipped.
- A key is `board#item` (for example `1200000101#9000000102`), because monday has no readable key. The item id is the identity: when an item moves to another board it keeps its id and gets a new key, and inkledger follows it.
- For each item: name, link, board (and its workspace, when it is not the main one), group (kept as a field), status label, priority (a status column with the id `priority`), tags, due date, the timeline's start, people (all people columns), creator, parent, the dates it was created, updated and entered its status, the **tracked time** (the time tracking column, read only) and the other text columns as fields.
- **Statuses**, per board, from its status column (the one with the id `status`, else the first that is not a priority). A label is an index of that board; its category comes from monday only for "done" (the column's done colours) and "no label" (backlog). monday does not say whether "Working on it" or "Stuck" are in progress, so every other label is "todo" until the connection's `categories` option maps it by name, for example `{"working on it": "doing"}`.
- The description (a long text column called `description`), the **updates** (comments, as HTML, replies included) and the item's **history** (the board's activity log).
- Items that left your list: a deleted or archived item is reported as deleted. An item handed to someone else is not reported (monday offers no feed for it); reconciliation finds it.
- Text search across the names of the items in the boards you can see.

## What inkledger writes

- A move to another label of the item's status column (any label, from any other; monday has no transition table).
- Updates (comments), written from Markdown as the HTML monday keeps: paragraphs, bold, italic, links and lists. Headings, quotes, code and tables are written as plain paragraphs and reported as approximated.

Nothing else is written. Time is **not** sent to monday: the time tracking column can be read but not written, so the time you file stays in inkledger's own register.

## Token

Create a personal API token in monday: your avatar, Developers, My access tokens (or Administration, Connections, Personal API token for admins). A personal token has your own access: it can read and write what you can. Paste it into the connection form as is: inkledger sends it in the `Authorization` header without `Bearer`, as monday documents, and pins the schema with `API-Version: 2025-07`. An OAuth access token also works (sent with `Bearer`); refreshing it is the connection layer's job. Scopes, when you make an OAuth app: `me:read`, `boards:read`, `boards:write`, `updates:read`, `updates:write`, `users:read`; the activity log needs `boards:read`. Unconfirmed on a real account.

## Limits

monday counts a query's complexity (the size of what it asks for, not what it gets) against a per-minute budget, caps one query at 5,000,000 points, and limits requests per minute and per day by plan. inkledger reads 50 items a page, asks for at most 5 boards and 25 items per board in a search, and waits when monday says the budget is spent (a normal answer, with the seconds to wait) or answers 429.

## Self-hosted

monday.com is a hosted service only. The connection's API base is `https://api.monday.com/v2`.

## Webhooks

The adapter has the verification monday documents: `Authorization` holds a JWT (HS256) signed with the app's signing secret, accepted only before its `exp`; the delivery id is the event's `triggerUuid`, its time `triggerTime`. A new subscription is first sent `{"challenge": "..."}` and wants the same JSON back (`mondayWebhook.challengeOf` builds the answer). Webhooks are not wired yet: syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real account: the last-updated filter and its granularity, the activity log's events, retention and time format, the exact complexity weights and error codes, the shape of the people, date and time tracking cells, the column type names across API versions, whether `items_page` reports a moved or reassigned item as changed, the webhook signature and payloads, and the category of the default status labels. See the spikes.
