# Shortcut

Status: experimental. The adapter was built against a simulator written from Shortcut's public REST API v3 documentation; it has not run against a real workspace. The assumptions to check are listed in `docs/dev/spikes.md`, section "Shortcut".

## What inkledger reads

- **Stories you own**, keyed `sc-123` (the story's public id, the number in every Shortcut URL). Completed stories are included; archived ones are not read on a first sync. Pasting `sc-123` or a story link (`https://app.shortcut.com/<workspace>/story/123/...`) finds the story; epic links are not stories and are refused.
- For each story: name, link, workflow state, workflow, type (feature, bug, chore), labels, owners (a story may have several), requester, parent (sub-tasks), deadline, estimate (points, kept in a field and never as time) and the dates it was created, updated and last moved.
- **Workflow states**, per workflow, with their category taken from Shortcut's state type (backlog, unstarted, started, done), never from the state's name: a workspace may call them anything. Shortcut has no "cancelled" type: a "Won't do" state is `done` unless you map it in the connection's category mapping.
- The description and the **comments** (Markdown; deleted comments are left out), and the story's **history** (status, workflow, title, description, type, estimate, deadline, owners, labels, archived).
- A story that was archived is reported as deleted. A story that was deleted for good is not in any feed: it is found by the webhook or by reconciliation, and then reads as gone (404).
- Text search across the stories you can see (archived ones are left out).

## What inkledger writes

- A move to another state of the story's own workflow (any state; Shortcut has no transition table).
- Comments, as Markdown.
- Following and unfollowing a story (the other followers are kept).

Nothing else is written. Time is not sent to Shortcut: it stays in inkledger's own register.

## Token

Create a personal API token in Shortcut: Settings, Your account, API Tokens, Generate Token (`https://app.shortcut.com/settings/account/api-tokens`). A token has your own access to the workspace you generate it in: it reads and writes what you can. Paste it into the connection form as is; inkledger sends it in the `Shortcut-Token` header. Shortcut has no narrower scopes for personal tokens. A token belongs to one workspace: connect again with another token for another workspace. Unconfirmed on a real account.

## Limits

Shortcut allows 200 requests a minute per token and answers `429` with a `Retry-After` header when it is spent; inkledger waits for it. A search returns at most 25 stories a page, so a full read of many stories takes several requests, and each page also reads the workspace's workflows and members (a story names its state and people by id only).

## Self-hosted

Shortcut is a hosted service only: there is no self-hosted server. The connection's API base is `https://api.app.shortcut.com`; the adapter adds `/api/v3`.

## Webhooks

The adapter has the verification Shortcut documents (`Payload-Signature`, the hex HMAC-SHA256 of the raw body under the webhook's secret; the body's `id` as the delivery id and `changed_at` as its time), but webhooks are signals only: syncing is by polling, and a delivery is only a reason to read the story again.

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real account: the search operators (`owner:`, `updated:`, `is:archived`) and how a word that looks like one is treated, the shape of a search page and its `next`, whether `updated:` counts UTC days, how long the search index lags, the 429 answer, what the story and history payloads carry, whether archiving is the right "gone", and the webhook signature and payloads. See the spikes.
