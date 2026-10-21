# Trello

Status: experimental. The adapter was built against a simulator written from Trello's public REST documentation; it has not run against a real account. The assumptions to check are listed in `docs/dev/spikes.md`, section "Trello".

## What inkledger reads

- **Cards assigned to you**, on every board you belong to, keyed by the card's short link (the 8 characters in `https://trello.com/c/Lg4nS4f1/…`). The short link is the card's identity for people: it stays when the card moves to another board, while the number shown on the board changes (inkledger keeps that number as a field).
- For each card: title, link, the list it sits in (its status), board, labels (a label with a colour and no name shows its colour), members, due date, whether the due date is marked complete, the start date, and the dates it was created (read from the card's id) and last had activity.
- **Lists**, per board, in board order. Trello gives lists no meaning, so their category (backlog, todo, doing, done, cancelled) comes from the connection's own mapping, never from a list's name. See "Categories" below.
- The description and the **comments** (Markdown), and the card's **history** (list moves, renames, due date, description, labels, members, archiving).
- Cards that left your list: an archived card is reported as deleted, a card deleted from its board as deleted, and a card you were taken off as moved out. The last two come from the boards' action logs.
- Text search across the cards you can see.

## What inkledger writes

- A move to another open list of the card's board.
- Comments, as Markdown.
- Subscribing to and unsubscribing from a card.

Nothing else is written. Time is not sent to Trello (Trello has no time tracking): it stays in inkledger's own register.

## Categories

A connection's options hold `categories`: the category of each list, by list id or by list name (any case). For example `{ "Doing": "doing", "Done": "done", "Won't do": "cancelled" }`. A list nobody mapped is read as `todo`. An id wins over a name. There is no screen for this yet.

## Token

Trello needs two values: the **API key** and a **token**. Both are made at `https://trello.com/power-ups/admin`: create a Power-Up (it can stay private), open its "API key" page and generate the key, then use the "Token" link on that page to authorize it for your account. Read access is enough to sync; moving cards and commenting need read and write. Paste them into the connection form as one value, `<key>:<token>`.

inkledger sends them in the `Authorization` header (`OAuth oauth_consumer_key="…", oauth_token="…"`), as Trello documents, and never in the URL. Unconfirmed on a real account.

## Limits

Trello allows 100 calls per 10 seconds per token and 300 per key. Over a budget it answers 429; inkledger waits one window (10 seconds) and tries again. A sync reads a member's cards in one call and one more per board with an action log (only on passes after the first).

## Self-hosted

Trello is a hosted service only. The connection's API base is `https://api.trello.com`.

## Webhooks

The adapter has the verification Trello documents (`X-Trello-Webhook`, the base64 HMAC-SHA1 of the raw body followed by the callback URL, under the **API secret** of the key's app) but webhooks are not usable yet: Trello signs with the app's secret, not with a secret inkledger generates, and the callback URL is part of what is signed. The adapter reads the stored secret as `<app secret>`, a newline, `<callback URL>` and refuses anything else. Syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real account: the Authorization header form, the parameters of `/members/me/cards` and `/members/me/boards`, the shape of rate-limit answers, which action types the board logs record for deleted cards and removed members, whether `dateLastActivity` moves for every change that matters, how search treats partial words and archived cards, what a comment POST returns, and the webhook signature. See the spikes.
