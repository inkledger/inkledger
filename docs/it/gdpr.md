# Data protection (GDPR) notes

Not legal advice. It describes what the software holds and does, so an operator can complete their own records.

## Roles

inkledger is self-hosted: the organisation that runs the server is the **controller** and decides purposes and retention. The project ships no processor: it receives no data and has no telemetry. Services the server may call are optional and listed in [outbound.md](outbound.md); each one you enable (tracker vendors, Microsoft, a hosting or backup provider, the module store) belongs in your own processor and sub-processor list, with its own agreement.

Choose and record your own lawful basis (for work time tracking, typically the employment contract or a legitimate interest, with works-council or local-law rules where they apply).

## What is held

Account details (username, display name, email, role), sign-in records, time entries, timers, plans, notes, to-dos, ideas, tracker connections (credentials sealed), pinned mails (opt-in, sealed), and the audit log (actor, client address). Groups, encryption and retention per table: [data-flow.md](data-flow.md).

## Retention

Automatic purges (every 6 hours): sessions at expiry, deleted worklogs, notes and ideas after 30 days in the trash, dismissed notifications 30 days, timer runs 30 days, unused module files 30 days, webhook intake 2 days, orphaned mail copies 7 days, mail read records 365 days, flow analysis 30 days raw and 365 days aggregated (per user), audit log 400 days by default (minimum 90, Settings → Audit log). Everything else stays until it is deleted. Backups keep what the database held when they were taken, for the newest N files (default 14): deleting data does not change older backups.

## Data subject rights today

- **Access and portability:** the person can see their data in the app. There is no one-click export yet. An operator can export a user's audit events (Settings → Audit log, filter by actor, then CSV or JSON) and extract a user's rows from the database with SQL, using the tables in [data-flow.md](data-flow.md). Time logged in a tracker is exported from the tracker.
- **Rectification:** users edit their own entries and settings; an admin renames accounts.
- **Restriction:** an admin can turn an account off (it keeps its data but cannot sign in).
- **Erasure:** there is no account delete yet. A user's own deleted items are purged after 30 days, and a connection can be removed by its owner. Removing a user's rows from the database by hand is possible but must follow the foreign keys (connections first, then what depends on them, then the user); take a backup first. Older backups still hold the data until they are pruned. Tracker-side data is the tracker's.
- **Audit log:** it is append-only for integrity, so entries naming a person are removed only by the retention purge.

## Planned (not available yet)

- **Export:** a per-user export (a ZIP of JSON/CSV with worklogs, timers, planned entries, notes, to-dos, ideas, settings, connection metadata without secrets, and audit events about the person), by the person or by someone granted a new permission. Planned.
- **Erasure:** an audited, owner-confirmed erase that deletes a user's data in a fixed order and pseudonymises the audit rows that name them. Tracker-side worklogs stay untouched. Planned.

## Security measures

See [security-one-pager.md](security-one-pager.md). Breach handling: [runbook-incident.md](runbook-incident.md).

## Sub-processor list (template)

| Service | Purpose | Data sent | Location | Agreement | Optional |
| --- | --- | --- | --- | --- | --- |
| <tracker vendor> | Time and issue sync | What users log and read | | | Per connection |
| <hosting provider> | Runs the server | Everything | | | No |
| <backup storage> | Copies of backups, if you ship them | Everything (encrypt it) | | | Yes |
| Microsoft | Mailbox search | Search queries, mail ids | | | Yes (`MS_CLIENT_ID`) |
| Open-Meteo | Weather for modules | Coordinates rounded to 0.1 degree | | | Yes (`WEATHER=off`) |
| Module store | Licences | Licence requests | | | Yes (`STORE_URL=off`) |
