# Loop: building the idea specs

Started 2026-10-29. The queue follows `README.md` ("Implementation order"); git and the code win over this file.

| Batch | Doc | R / AC | State | Commit | Checks run (command → outcome) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| B3.1 | estimates | AC-3.1–3.15, 3.46–3.48, 3.52, 3.56, 3.57 | done | (this commit) | `vitest run contracts/estimate.test.ts` → 21/21; mutation check (current status, sourceOrdinal removed) → 2 fail as expected; `pnpm lint` → ok; `pnpm check` → ok; `pnpm test` → 195 files, 2374 passed; `pnpm build` → ok; `pnpm test:smoke` → 21 ok | Spec revision 3 + patch 3.1 + 5 corrections. AC-3.57 passed before its grouping too (strict `<` already); no coverage tool in the repo |
| B3.2a1 | estimates | 2a1: AC-3.58, 3.59, 3.60 (single-field rows) | todo | | | contract `statusHistory`, Jira numeric ids, Azure/Linear/Monday/Plane/Redmine/Shortcut/Trello/YouTrack; check Plane identifiers and YouTrack `$type`/`field.id` first |
| B3.2a2 | estimates | 2a2: AC-3.60 (composite rows), 3.61, 3.62 | todo | | | Asana, Basecamp, GitLab, Gitea, Todoist, OpenProject; real-API facts first |
| B3.2 | estimates | AC-3.24–3.28, 3.49, 3.55 | todo | | | after B3.2a |
| B3.3 | estimates | AC-3.16–3.23, 3.29, 3.50, 3.51 | todo | | | |
| B3.4 | estimates | AC-3.41–3.43, 3.45 | todo | | | |
| B3.5 | estimates | AC-3.44 (accuracy) | todo | | | |
| B2.1 | triage | R-2.1–2.3, 2.7, 2.9; AC-2.1–2.9, 2.12 | todo | | | |
| B2.2 | triage | R-2.11; AC-2.15, 2.16, 2.20, 2.21 | todo | | | |
| B2.3 | triage | R-2.5, 2.6; AC-2.11, 2.17, 2.22 | todo | | | |
| B2.4 | triage | R-2.4, 2.10; AC-2.10, 2.18 | todo | | | |
| B5.1 | infra | R-5.1, 5.2, 5.6; AC-5.1, 5.2, 5.6, 5.7 | todo | | | |
| B5.3 | infra | R-5.3; AC-5.3 | todo | | | |
| B2.5 | triage | R-2.8; AC-2.13, 2.14, 2.19 | todo | | | Q3 blocks |
| B5.4 | infra | R-5.5; AC-5.4 | todo | | | |
| B3.6 | estimates | AC-3.39, 3.40 | todo | | | Q1 blocks |
| B3.7 | estimates | AC-3.30–3.38, 3.44, 3.45 | todo | | | |
| B1.1–B1.6 | mail-copies | see doc | todo | | | Q1, Q2 block |
| B4.1–B4.5 | onchain-licences | see doc | todo | | | Q1–Q3 block |
| B5.2 | infra | R-5.4; AC-5.5 | todo | | | Q1 blocks |
