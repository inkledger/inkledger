# Notion

Status: experimental. The adapter was built against a simulator written from Notion's public REST documentation; it has not run against a real workspace. The assumptions to check are listed in `docs/dev/spikes.md`, section "Notion".

## What inkledger reads

- **The pages of one database**, whose people property (default `Assignee`) holds you. The database is named in the connection's options (`database`, its id, the 32 characters in its URL). A workspace has many databases; each connection reads one.
- Each page is keyed by its id, as 32 hexadecimal characters (the end of its URL): Notion has no shorter key. Pasting a page link, an id with or without dashes, or a link that opens the page inside a database view (`?p=`) finds it. A link to the database itself is not a page.
- For each page: title, link, status, assignees, due date (a date property named in the options, `due`), and the dates it was created and last edited. `last_edited_time` is rounded to the minute by Notion; a sync reads two minutes back so nothing edited inside a checkpoint's minute is missed.
- **Statuses**: the options of the status property (`status`, default `Status`). A native *Status* property puts its options in three groups (To-do, In progress, Complete) and inkledger reads the category from the group. A *Select* property has no meaning of its own; see "Categories".
- The description: the text blocks at the top level of the page's body (paragraphs, headings, lists, to-dos, quotes, callouts, code, dividers). What sits inside toggles, columns or nested lists is not read.
- **Comments** of the page, oldest first, with authors named. Comments on one block of the body are not part of the page's comments and are not read.
- Pages that left your list: a page in the trash or removed for good is reported as deleted. A page given to someone else, or moved out of the database, just stops being yours (no departure is reported).
- Text search over the titles of the database's pages.

## What inkledger writes

- A new status on a page (the option, written on the property by their ids).
- Comments, as rich text: paragraphs, bold, italic, code and links. Headings, lists, quotes, tables, code blocks and images stay as text and the app is told they were approximated. A text longer than 2,000 characters is split; more than 100 pieces of formatting in one comment are refused.

Nothing else is written. Time is not sent to Notion (it has no time tracking): it stays in inkledger's own register.

## Categories

A `status` property gives its categories by its groups: To-do is *todo*, In progress is *doing*, Complete is *done*. Notion has no group for *cancelled* or *backlog*. The connection's options hold `categories`, the category of each option by option id or by option name (any case), for example `{ "Won't do": "cancelled", "Backlog": "backlog" }`; it wins over the group. A `select` property reads only from `categories` and any option nobody mapped is *todo*. A page with no status yet is *triage*. There is no screen for this yet.

## Token and who you are

Make an **internal integration** at `https://www.notion.so/profile/integrations` (workspace owner). Give it the capabilities *Read content*, *Update content* (to change a status), *Read comments* and *Insert comments*, and *Read user information including email addresses* (to find you by email and to name comment authors). Copy its secret (it starts with `secret_` or `ntn_`) into the connection form.

Then **share the database with the integration**: open the database, the `...` menu, *Connections*, add the integration. A database that is not shared answers "not found", the same as one that does not exist.

An internal integration belongs to the workspace, not to a person, so inkledger cannot tell whose pages are yours. Set the option `user` to your Notion user id or your email. (A public integration names the user who authorized it; then `user` is not needed.)

## Options

| Option | Meaning | Default |
| --- | --- | --- |
| `database` | the database's id | required |
| `user` | your Notion user id or email | the integration's owner, when a person |
| `status` | name of the status property (type Status or Select) | `Status` |
| `assignee` | name of the people property | `Assignee` |
| `due` | name of the date property for the due date | none |
| `categories` | category of each status option, by id or name | `{}` |

Properties are found by their name in the database and then used by their id, so renaming one in Notion shows up as a clear error until the option is changed.

## Limits

Notion allows an average of three requests a second. Over it, it answers 429 with `Retry-After` in seconds and inkledger waits that long. A sync is one query per 100 pages plus one more query per 100 pages to tell what left, and a request per page that left; comments cost one request for each author.

## Self-hosted

Notion is a hosted service only. The connection's API base is `https://api.notion.com/v1`; inkledger sends API version `2022-06-28`.

## Webhooks

The adapter has the verification Notion documents (`X-Notion-Signature: sha256=<hex HMAC-SHA256 of the raw body>` under the subscription's *verification token*, which Notion sends once in a first request holding only that token; deliveries have an `id` and a `timestamp`). Page events and `comment.created` are read as signals and the page is read again. The verification token is the connection's webhook secret. Webhooks need a public address Notion can reach; syncing is by polling.

## Not verified yet

Everything above is from the documentation. In particular, not checked on a real workspace: the owner object of an internal integration, the filters and `filter_properties` of a database query, rounding of `last_edited_time`, what a trashed page answers, comments listed by page id, what the user endpoints give without the user-information capability, the shape of `date` properties with time zones, and the webhook signature and event names. See the spikes.
