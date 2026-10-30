# Ideas: strict specs and the loop that builds them

Ideas from 2026-10-29, specified so an agent can build them without inventing anything. Each file is one idea:

| Doc | Idea |
| --- | --- |
| [mail-copies.md](mail-copies.md) | #3 keep pinned mails when Outlook deletes them |
| [triage.md](triage.md) | #6 a waiting room that turns ideas into issues |
| [estimates.md](estimates.md) | #7 issue estimates from history, finish dates with Timestral |
| [onchain-licences.md](onchain-licences.md) | #2 module purchases provable on Bitcoin |
| [infra.md](infra.md) | the services they need, in containers |

Answers to open questions go under each Q in its doc, with the date. The loop reads them there; a proposal is never an answer.

## Rules for every spec

**Notation**
- `R-<doc>.<n>` is a requirement. It uses **MUST** or **MUST NOT** (mandatory) or **SHOULD** (to do unless the doc gives a reason).
- `AC-<doc>.<n>` is an acceptance criterion in Given/When/Then form. **Each AC has exactly one test** with the name given, and that test name is the AC text.
- `E-<doc>.<n>` is an error: code, i18n key, when it happens.
- A requirement with no AC is not done.

**General requirements**
- **R-0.1**
  - Every feature MUST be gated by an env flag or a user setting.
  - When the service is missing, the related UI MUST NOT render: no disabled buttons and no errors on load.
  - Availability MUST come from the feature's own router, not from a global endpoint. Pattern: `mails.account` returns `{available}` (`api/routers/mails.ts:197`).
- **R-0.2**
  - Every external service MUST have a deterministic simulator, enabled by `<NAME>_SIMULATOR=1`, following `api/mail/simulator.ts`.
  - Unit tests and e2e MUST NOT reach the network. `api/test-setup.ts` already blocks `fetch`.
- **R-0.3** Calls to local services (Ollama, forecast):
  - MUST use plain `fetch` with `AbortSignal.timeout(ms)` and `redirect:"error"`, as in `api/weather/openMeteo.ts:30` and `api/store/client.ts:70`;
  - MUST NOT go through `safeFetch` or `assertSafeUrl`, which refuse private addresses (`api/lib/security.ts:73`);
  - MUST take their URL only from env, never from user input.
- **R-0.4**
  - Background jobs MUST follow `startSyncScheduler` (`api/syncScheduler.ts:93`): recursive `setTimeout` plus `unref()`, timed from the end of the previous run, returning `stop(): Promise<void>` that is called during shutdown in `api/boot.ts`.
  - Purges MUST be functions `purgeX(now = Date.now()): Promise<number>` added to the list in `api/boot.ts:168`.
- **R-0.5**
  - Migrations MUST be created with `pnpm db:generate`, renamed to `NNNN_<name>.sql` together with their journal tag, and use the next free number (0017 is `note_folders`).
  - Their `when` MUST be greater than the previous migration's (`api/queries/migrationGuard.ts`).
  - The schema-drift test (`api/queries/schema-drift.test.ts`) MUST pass.
- **R-0.6** UI:
  - MUST follow `docs/design-system.md` §6.1 (reuse components), §11 (hard rules) and §12 (checklist);
  - MUST work at 320 px with no horizontal overflow;
  - MUST look right in light and dark, compact and comfortable;
  - every region MUST handle loading, empty, error (with Retry) and busy;
  - all text MUST be i18n keys with English and Italian added together, then `pnpm parity:update`.
- **R-0.7** Server strings MUST live under `server.<feature>.*` and be thrown as `TRPCError({code, message: t("server.…")})`, following `api/routers/todos.ts:63-70`.
- **R-0.8**
  - Every procedure that takes a resource id MUST check ownership and return NOT_FOUND (never FORBIDDEN, so existence is not revealed).
  - It MUST be covered by an IDOR test with a second user, as in `api/routers/idor.test.ts`.
- **R-0.9** New zod inputs:
  - MUST bound every string (`.max`) and array (`.max`);
  - numbers MUST be `.int()` and bounded;
  - ids are `z.number().int().positive()`.
- **R-0.10**
  - Nothing in these docs may push, deploy (app or Worker), touch the `jtt` stack or the prod/staging containers, write to real trackers or mailboxes, sign licences, or clear caches.
  - Tests and e2e always run with `PROVIDERS_READ_ONLY=1`.
- **R-0.11** These MUST NOT change from the starting state of a batch, except where the batch says otherwise:
  - the render budget (`e2e/renders.test.mjs`);
  - the perf measures (`docs/dev/performance.md`).
- **R-0.12 (ask, don't presume)**
  - No doubt may be settled by assumption. This covers an open question, a gap or ambiguity in the doc, a deviation forced by the real code, and an unexpected result.
  - Each one MUST become an **explicit request to the user** (AskUserQuestion) at the moment it becomes blocking. The request carries:
    - context and evidence (file:line, output);
    - concrete options with pros and cons;
    - what changes depending on the answer.
  - The answer is written into the doc under its Q, with its date. It applies **only** to that question.
  - The "proposals" in the docs are starting points for the discussion, **never defaults to apply**.
  - Known gaps are not filled now. They are dealt with in depth with the user when they are reached.

**Each doc's format (14 sections, in this order)**
1. Status (with date)
2. Problem
3. Requirements R
4. Out of scope
5. Decisions, each with its *why*
6. Data model, as exact drizzle code
7. API: verbatim zod, output, the E table
8. UI: tree, states, keys, i18n with English and Italian text
9. Privacy and security
10. Performance with numeric budgets
11. AC → test
12. Edge cases
13. Batches, each listing its R/AC
14. Open questions. Each one says **which batch it blocks**, and gives a **proposal** (for discussion, never applied without an answer, R-0.12) and the answer with its date once given.
   - Where these specs write "not blocking (default X)", read "proposal X, to ask when the batch that touches it is reached".

**Implementation order:**
0. **First, before everything:** `issue-copy.md` batches C1–C4 (added 2026-10-30)
1. B3 batches 1–3
2. B2 batches 1–4
3. B5 batches 1, 3
4. B2 batch 5
5. B5 batch 4, then B3 batches 4–5
6. B1 (after its Q's)
7. B4 (after its Q's)

---

## The loop
Start it once these docs are committed. Write the answers to the open questions straight into the docs, under each Q: the loop reads them there.

```
/loop Implement the strict specs in docs/work/ideas/, one batch per iteration, in the order given in docs/work/ideas/README.md.

STATE: docs/work/ideas/LOOP.md. On the first run create it from the README: table | batch | doc | R/AC | state (todo/doing/done/blocked) | commit | checks run (command → outcome) | notes |. On every run re-read it, but git and the code win over it.

EACH ITERATION
1. Context: CLAUDE.md, docs/work/ideas/README.md (common rules R-0.x), the current doc, docs/design-system.md if there is UI. `git status`: changes that are not yours and not committed → stop and report, touch nothing.
2. Choose the first `todo` batch. Before writing code, list every doubt the batch touches: the Qs of the doc that concern it without a written answer (proposals included: they are not answers), gaps or ambiguities in the doc, deviations the real code forces. If there is even one → DO NOT assume and DO NOT skip: STOP and ask the user with AskUserQuestion (context with file:line and evidence, concrete options with pros and cons, what changes), go deep on the problem with the user until the answer is clear, write it into the doc under its Q with its date, then continue. Never decide by yourself, in particular: product, privacy, licences, dependencies, costs, staging/prod, anything that writes outside this machine. The same rule holds during implementation and verification: an unexpected doubt → stop and ask.
3. Implement exactly the R of the batch. For each AC of the batch: write the test with the EXACT name from the table, see it fail for the expected reason, then implement until it passes. Data model and zod exactly as in the doc (if the real code forces a deviation, write it under "Decisions" in the doc with the reason). Migrations per R-0.5. English + Italian strings with the texts from the doc, then pnpm parity:update.
4. Verify: pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke; PROVIDERS_READ_ONLY=1 node --test <the e2e named in the batch>; every 3 batches the whole PROVIDERS_READ_ONLY=1 pnpm test:e2e. UI: dev :3000 with PROVIDERS_READ_ONLY=1, light/dark, 320 px and desktop, screenshot. Failure: one fix based on the evidence; if it fails again → set aside only your changes for the batch (git stash push -- <your files>), `blocked: <check> <error>`, move on.
5. Review the full diff: no stray files, no `any`/@ts-ignore, no lint silenced, no limits of existing tests changed, every AC of the batch has its test. Local commit `type(scope): desc` ≤ 50 characters, the repository's git identity, no trailer.
6. Update LOOP.md (state, commit, commands → outcome) and the doc (Status, batch checkbox, decisions found in the code), in the same commit.

NEVER: push, deploy (app, Worker/wrangler, images), touch the jtt stack or the prod/staging containers and volumes, write to real trackers or mailboxes, sign or self-sign licences, clear caches, install global tools, change test limits to make them pass.

END: when no `todo` batches remain, write at the top of LOOP.md and in chat: batches done (commits), blocked ones with their exact question, what the user must do (answer the Qs in the docs, review, push). Then stop the loop.
```

---
