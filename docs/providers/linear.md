# Linear

Status: experimental. The adapter was built against a simulator written from Linear's public GraphQL documentation; it has not run against a real workspace. The assumptions to check are listed in `docs/dev/spikes.md`, section "Linear".

## What inkledger reads

- **Issues assigned to you**, in every team you can see, keyed by Linear's identifier (`ENG-123`). Completed and canceled issues are included; archived ones are not read on a first sync.
- For each issue: title, link, workflow state, team, priority (Urgent, High, Medium, Low; "No priority" is left empty), labels, assignee, creator, parent (sub-issues), due date, estimate (kept as points in a field, never as time) and the dates it was created, updated and entered its state.
- **Workflow states**, per team, with their category taken from Linear's state type (triage, backlog, unstarted, started, completed, canceled), never from the state's name: a team may call them anything.
- The description and the **comments** (Markdown, including those written by integrations), and the issue's **history**.
- Issues that left your list: a trashed issue is reported as deleted, and one you were subscribed to that now belongs to someone else as moved out.
- Text search across the issues you can see.

## What inkledger writes

- A move to another state of the issue's team (any state; Linear has no transition table).
- Comments, as Markdown.
- Subscribing to and unsubscribing from an issue.

Nothing else is written. Time is not sent to Linear (Linear has no time tracking): it stays in inkledger's own register.

## Token

Create a personal API key in Linear: Settings, Account, Security & access, Personal API keys, New key. A key has your own access: it can read and write what you can. Paste it into the connection form as is (it starts with `lin_api_`). inkledger sends it in the `Authorization` header without `Bearer`, as Linear documents for personal keys. If Linear offers permissions when creating the key, Read is enough to sync; moving issues and commenting need Write (or the narrower create-comment permission for comments only). Unconfirmed on a real account.

An OAuth access token also works (sent with `Bearer`); refreshing it is the connection layer's job.

## Limits

Linear limits a personal key to about 5,000 requests an hour and gives each query a complexity budget (10,000 points per query, a larger hourly total). inkledger reads 50 issues per page, honours the `X-RateLimit-*` headers, and waits when Linear answers "rate limited" (which Linear sends as HTTP 400, or 429).

## Self-hosted

Linear is a hosted service only: there is no self-hosted server. The connection's API base is `https://api.linear.app`; the adapter adds `/graphql`.

## Webhooks

The adapter has the verification Linear documents (`Linear-Signature`, an HMAC-SHA256 of the raw body under the webhook's signing secret, and the `webhookTimestamp` in the body, refused when more than 60 seconds old) but webhooks are not wired yet: syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real account: the exact rate-limit answer and header units, the complexity weight of a page, whether an unassigned user stays subscribed (departures), whether an old identifier still resolves after a move between teams, the error shape for a missing issue, and the webhook signature and payloads. See the spikes.
