# Status: issue chat

## Goal and done criteria
In-app chat between teammates about a tracker issue: 1:1 that can grow, a Chat tab in Notifications,
a Chat section on the issue, Markdown, files, issue/worklog/comment cards, typing and read receipts,
publish to the tracker. Done = the plan's batches 1–5 landed with their tests, full gate green,
targeted e2e, visual review in every look and density.

## Constraints and out of scope
- Only teammates (shared team) with a connection to the same tracker, verified read-only with *their*
  connection (getIssue) when asked in. Access lost later is not re-checked (v1).
- Threads anchor on tracker type + base URL + the issue's remote id (every user keeps their own copy).
- No notification rows for chat (the tab and the bell badge count unread messages).
- Out of scope: presence (live-decisions batch 9), Web Push with no tab open, chats without an issue,
  multi-process event bus.

## Decisions
- Typing is ephemeral: `publishEphemeral` takes no seq, is not kept, goes out without an SSE id
  (a numbered one would make `missedSince` see gaps and force resyncs).
- GDPR: chat tables are shared; `chat_members`/`chat_reactions` are the person's, threads/messages/files
  are `special` with a dedicated `chat.json` export; erasure leaves words nameless (author set null),
  `purgeChat` drops threads nobody is left in and files never sent after a day.
- Message length = 10 000 (tracker comment limit) so "publish to tracker" never fails on length.
- Rate limits in memory: 30 messages/min per person, one typing signal per ~2 s per thread.

## Batches
- [x] 1 Foundations: contracts/chat.ts (+ chatSchemas.ts), schema + 0061_issue_chat.sql, access/store/router, GDPR, audit, authz cases
- [x] 2 Live: chat event, ephemeral typing (no seq, no SSE id), rate limits, typing told again right after a send
- [x] 3 UI core: Chat tab in Notifications (tabs in PageHeader), list + thread + composer, teammate picker, issue button and section, bell/tab badges, toasts and system notifications (click opens the chat through the service worker)
- [x] 4 Files and cards: sealed upload/download with their own body limit, paste/drag/progress, send queued while uploading, viewer, issue/worklog cards, "Discuss in chat" from a tracker comment, draft-file purge
- [x] 5 Workflow: resolve/reopen, reply, edit (↑), remove, reactions, mute/pin/archive, search, permalinks (page loaded around the message), publish a message as a comment, attach a message's files on the tracker, palette entry
- [ ] 6 Extras (optional, not done): local-model summary

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| pnpm check | all | green |
| pnpm vitest run api/chat api/events.test.ts | chat behaviour, SSE ephemeral | 33 passed |
| pnpm vitest run api/authz-idor.test.ts api/gdpr | authorization, GDPR | 558 passed |
| pnpm test | all | 4745 passed after audit snapshot update |
| mutation checks | ephemeral id, monotonic read, teammate check | each caught by a test |
| pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke | all | green: 4757 tests; first load 857.1 KiB (budget 925) |
| e2e/issue-chat.test.mjs | two users live, comment quote, reply/react/edit/remove/search/permalink, 320 px and desktop geometry | 3 passed |
| PROVIDERS_READ_ONLY=1 pnpm test:e2e | all | 531 passed, 12 skipped, 1 failed once (dashboard-day "stopped timer left for later"): not reproduced in 11 reruns on the branch (alone, CPU x6, and beside regressions.test.mjs), passes on main too |
| related suites (notifications, header, space budget, themes, issue pages, regressions) | regressions | 115/115 |

## Decisions (UI)
- Tabs belong to the page header (PageHeader `tabs` prop): sticky with it and in its measured height, so
  the split's heights stay right on both tabs.
- The chat over the list (narrow) is sized from where it starts to the first of: window, page panel,
  tab bar (fixed: detected by its height), re-measured when anything above it resizes.
- No zod in contracts/chat.ts: the client contract was pulling it into the first load (954 KiB > 925).

## Blockers and next step
None. Next: merge main, re-run the gate, merge into main, CI.
