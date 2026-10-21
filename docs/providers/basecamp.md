# Basecamp

Status: experimental. The adapter was built against a simulator written from Basecamp 3/4's public API documentation; it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "Basecamp".

## What inkledger reads

- **To-dos and cards assigned to you**, in every project you can reach. A first read takes the open ones from "My assignments" (each read in full); later reads take every to-do and card changed since the last one, newest change first, and keep the ones assigned to you.
- Each is keyed `BC-<project id>-<id>`. A Basecamp to-do or card is a "recording" with an id of its own, but every call also needs its project, so the key carries both. The web link of a to-do (`3.basecamp.com/<account>/buckets/<project>/todos/<id>`) or card (`.../card_tables/cards/<id>`) is understood wherever a key is. Moving a to-do to another project makes a new to-do with a new id and key (the old one goes to the trash).
- For each: title, link, project (the container), status, assignees (several allowed), creator, due and start date, the dates it was created and changed, and when it was completed.
- **Status**: Open or Completed for a to-do. A card also sits in a column of its project's card table: Triage, Not now and Done have a meaning of their own (triage, backlog, done); any other column is a status only when the connection's options name it (`columns`, a map from column title to category). The category is never guessed from a title.
- The description, the **comments** (Basecamp's rich text) and the **history** (completion, assignment and content changes). Your Basecamp notifications are not read yet (the `inbox` trait is set for later).
- **Timesheet entries** of a to-do or card: day, hours and minutes, note, who logged them. Other people's entries are read-only. The feed re-reads the last month of your entries from the timesheet report.
- Text search over your to-dos and cards (Basecamp's search finds every kind of item, everybody's; inkledger keeps yours).

## What inkledger writes

- Complete / reopen a to-do; move a card to another column of its card table (only columns with a category).
- Comments, from Markdown to the tags Basecamp's editor keeps: bold, italic, strike, links, lists, code blocks, quotes, one heading level. Heading levels beyond the first, inline code, tables and images are written as plain text, and the app says so.
- Subscribing to and unsubscribing from a to-do or card.
- Timesheet entries: create, change, delete (an entry is moved to the trash), on a day, in whole minutes, optionally for another person.

Writes are off for this connection until you allow them (the adapter is not verified yet).

## Token

Basecamp has no personal access tokens: an OAuth 2 access token comes from a 37signals integration (https://launchpad.37signals.com/integrations, then the authorization flow of the app you register). Paste the access token as is; inkledger sends it as `Authorization: Bearer <token>` together with a `User-Agent` (Basecamp refuses calls without one). The token has your own access to every account it was granted.

A token may be for several accounts. Leave the connection's `account` option empty and inkledger uses the only Basecamp 3/4 account listed by `launchpad.37signals.com/authorization.json`; with several, set `account` to the number in your Basecamp addresses (`3.basecamp.com/<account>/...`).

## Limits

Basecamp allows 50 requests per 10 seconds per IP; a refused request answers 429 with `Retry-After` in seconds, which inkledger waits out. Lists are read 15 records per page, following the `Link: <...>; rel="next"` header (only to the same server). The first read costs one call per assigned to-do.

## Self-hosted

Basecamp is a hosted service only. The connection's API base is `https://3.basecampapi.com`.

## Webhooks

Basecamp webhooks (per project, with a payload URL and the kinds wanted) carry no signature. inkledger puts the connection's secret in the URL, which the core checks; the adapter only checks that the body is a Basecamp payload (`kind`, `recording`), takes the delivery's `id` to refuse replays and its `created_at` to refuse stale ones. Webhooks are not wired yet: syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular: the recordings list (full to-do fields, `status`, `sort`), "My assignments" (what it holds, cards in it), the card table (one per project, the column types, moves), timesheet entries and the report (fields, hours format, trash), search, event names, the OAuth token and launchpad lookup, the webhook payloads, and how to-dos moved between projects are reported. See the spikes.
