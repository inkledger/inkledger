// The worklog feed into the registry, scenario by scenario, as it ends in the database:
// worklogs, their sinks, the queue. The snapshots were written by the per-entry code
// (before Wave 2) and the batched one must end the same (docs/dev/measuring.md).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { timeZone } from "@contracts/values";
import { unlimited } from "./budget";
import type { BoundTracker } from "../providers/core/bind";
import type { RemoteWorklog } from "../providers/types";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const zone = timeZone("Europe/Rome");
const meta = { signal: new AbortController().signal, correlationId: "t" };
const at = (h: number, m = 0) => Date.parse(`2026-10-15T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+02:00`);

/** An entry of the feed: the user's ("me") on FAKE-1, a session of `seconds` from `start`. */
const entry = (remoteId: string, o: Partial<RemoteWorklog> & { start?: number; seconds?: number; key?: string | null } = {}): RemoteWorklog => {
  const { start, seconds, key, ...rest } = o;
  return {
    remoteId,
    issue: key === null ? null : { remoteId: `i-${key ?? "FAKE-1"}`, key: key ?? "FAKE-1" },
    span: { kind: "session", start: (start ?? at(9)) as never, seconds: seconds ?? 600 },
    comment: "",
    authorRemoteId: "me",
    ...rest,
    editable: rest.editable ?? { update: true, delete: true },
  };
};

describe("the worklog feed, page by page", () => {
  let userId = 0;
  let a = 0;
  let b = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('f', 'F', 1) RETURNING id");
    const conn = async (base: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', ?, 'me', '{}', 'x', 1) RETURNING id", userId, base))[0].id;
    a = await conn("https://a.example");
    b = await conn("https://b.example");
  });

  beforeEach(async () => {
    await q("DELETE FROM outbox");
    await q("DELETE FROM worklogs");
    await q("DROP TRIGGER IF EXISTS zz_fail ON worklogs");
  });

  /** One pass of one page (or several) of the feed into connection `id`. */
  const pass = async (id: number, pages: { items: RemoteWorklog[]; gone?: { remoteId: string }[] }[]) => {
    const { syncEntries } = await import("./worklogs");
    let n = 0;
    const tracker = {
      type: "gitlab",
      worklogs: {
        changed: async () => {
          const p = pages[n++];
          return n === pages.length ? { items: p.items, gone: p.gone ?? [], last: true, checkpoint: "c" } : { items: p.items, gone: p.gone ?? [], last: false, next: `p${n}` };
        },
      },
    } as unknown as BoundTracker;
    return syncEntries(tracker, { id, userId, remoteAccountId: "me" }, { since: null, meta, budget: unlimited, zone });
  };

  /** What the registry holds, without ids or sync times. */
  const state = async () => ({
    worklogs: await q(
      `SELECT c.base_url AS conn, w.issue_key, w.jira_worklog_id, w.time_spent_seconds, w.started, w.comment, w.author_account_id,
         s.state, s.remote_id, s.version, s.locked, s.remote_snapshot
       FROM worklogs w JOIN connections c ON c.id = w.connection_id
       LEFT JOIN worklog_sinks s ON s.worklog_id = w.id AND s.sink_connection_id = w.connection_id
       ORDER BY c.base_url, w.issue_key, w.jira_worklog_id, w.started`,
    ),
    outbox: await q("SELECT kind, issue_key, jira_worklog_id FROM outbox ORDER BY id"),
  });

  const local = (id: number, remoteId: string, o: { seconds?: number; start?: number; comment?: string; key?: string } = {}) =>
    q<{ id: number }>(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING id",
      userId,
      id,
      o.key ?? "FAKE-1",
      remoteId,
      o.start ?? at(9),
      o.seconds ?? 600,
      o.comment ?? "",
    ).then((r) => r[0].id);

  it("new entries: sessions, a day-only one, with versions and locks", async () => {
    const r = await pass(a, [
      {
        items: [
          entry("r1", { comment: "one", version: "v1" }),
          entry("r2", { start: at(10), seconds: 1800, locked: { cause: "approved" } as never }),
          entry("r3", { span: { kind: "date", date: "2026-10-15" as never, seconds: 3600 }, dayOnly: true } as never),
        ],
      },
    ]);
    expect(r).toMatchObject({ upserted: 3, removed: 0 });
    expect(await state()).toMatchSnapshot();
  });

  it("known entries: unchanged stays, changed on the service follows it, a day-only one keeps its clock time the same day", async () => {
    await pass(a, [{ items: [entry("r1", { comment: "one" }), entry("r2", { start: at(10) }), entry("r3", { span: { kind: "date", date: "2026-10-15" as never, seconds: 3600 }, dayOnly: true } as never)] }]);
    await q("UPDATE worklogs SET started = ? WHERE jira_worklog_id = 'r3'", at(14, 30));
    const r = await pass(a, [
      {
        items: [
          entry("r1", { comment: "one" }),
          entry("r2", { start: at(11), seconds: 900, comment: "moved there", version: "v2" }),
          entry("r3", { span: { kind: "date", date: "2026-10-15" as never, seconds: 5400 }, dayOnly: true } as never),
        ],
      },
    ]);
    expect(r).toMatchObject({ upserted: 3, removed: 0 });
    expect(await state()).toMatchSnapshot();
  });

  it("changed on both sides: a queued change here, or its sink not synced, keeps ours and the service's beside it", async () => {
    await pass(a, [{ items: [entry("r1"), entry("r2", { start: at(10) }), entry("r3", { start: at(11) })] }]);
    const [{ id: w1 }] = await q<{ id: number }>("SELECT id FROM worklogs WHERE jira_worklog_id = 'r1'");
    await q("UPDATE worklogs SET comment = 'mine' WHERE id = ?", w1);
    await q("INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, worklog_id, created_at) VALUES (?, ?, 'update', 'FAKE-1', 'r1', ?, 1)", userId, a, w1);
    await q("UPDATE worklog_sinks SET state = 'pending' FROM worklogs w WHERE w.id = worklog_sinks.worklog_id AND w.jira_worklog_id = 'r2'");
    await q("UPDATE worklogs SET comment = 'mine too' WHERE jira_worklog_id = 'r2'");
    const r = await pass(a, [{ items: [entry("r1", { comment: "theirs", version: "v9" }), entry("r2", { start: at(10), comment: "theirs too" }), entry("r3", { start: at(11), comment: "only theirs" })] }]);
    expect(r).toMatchObject({ upserted: 3, removed: 0 });
    expect(await state()).toMatchSnapshot();
  });

  it("ours, read back before their answer came: the same worklogs, the queued creates gone, never a second one", async () => {
    const created = await local(a, "new-1", { start: at(9) });
    await local(a, "pending-7", { start: at(13), seconds: 1200 });
    await q("INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, worklog_id, created_at) VALUES (?, ?, 'create', 'FAKE-1', '', ?, 1)", userId, a, created);
    // Two entries with the same time: only one of them is ours.
    const r = await pass(a, [{ items: [entry("r1", { start: at(9), locked: { cause: "closed" } as never }), entry("r1b", { start: at(9) }), entry("r7", { start: at(13), seconds: 1200 })] }]);
    expect(r).toMatchObject({ upserted: 3, removed: 0 });
    expect(await state()).toMatchSnapshot();
  });

  it("an entry named twice in a page, gone ones known, unknown and named twice, others' entries and entries without an issue", async () => {
    await pass(a, [{ items: [entry("g1"), entry("g2", { start: at(10) })] }]);
    const r = await pass(a, [
      {
        items: [entry("d1", { comment: "first" }), entry("x", { authorRemoteId: "someone" }), entry("n", { key: null }), entry("d1", { comment: "last", seconds: 900 })],
        gone: [{ remoteId: "g1" }, { remoteId: "nope" }, { remoteId: "g1" }],
      },
    ]);
    expect(r).toEqual({ checkpoint: "c", upserted: 2, removed: 1 });
    expect(await state()).toMatchSnapshot();
  });

  it("several pages, two issues; another connection's same remote ids are not touched", async () => {
    await pass(b, [{ items: [entry("r1", { comment: "B's" }), entry("r2", { key: "FAKE-2", comment: "B's" })] }]);
    const r = await pass(a, [{ items: [entry("r1"), entry("r2", { key: "FAKE-2" })] }, { items: [entry("r3", { start: at(15) })], gone: [{ remoteId: "r1" }] }]);
    expect(r).toMatchObject({ upserted: 3, removed: 1 });
    expect(await state()).toMatchSnapshot();
  });

  it("a page of 300", async () => {
    const items = Array.from({ length: 300 }, (_, i) => entry(`big-${String(i).padStart(3, "0")}`, { start: at(8) + i * 60_000, seconds: 60 }));
    expect(await pass(a, [{ items }])).toMatchObject({ upserted: 300 });
    const s = await state();
    expect(s.worklogs).toHaveLength(300);
    expect(s.worklogs.every((w) => (w as { state: string }).state === "synced")).toBe(true);
    // Read again: the same.
    await pass(a, [{ items }]);
    expect(await state()).toEqual(s);
  });

  it("a page of 2500, past what one statement takes, in slices", async () => {
    const items = Array.from({ length: 2500 }, (_, i) => entry(`huge-${String(i).padStart(4, "0")}`, { start: at(0) + i * 30_000, seconds: 30, comment: `c${i}` }));
    expect(await pass(a, [{ items, gone: [{ remoteId: "huge-0000" }] }])).toMatchObject({ upserted: 2500, removed: 1 });
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 2499 }]);
  });

  it("a page that fails halfway (the database refuses one entry) lands the same once read again", async () => {
    const items = [entry("ok1"), entry("bad", { start: at(10) }), entry("ok2", { start: at(11) })];
    await local(a, "keep", { start: at(16), comment: "untouched" });
    await q(`CREATE OR REPLACE FUNCTION zz_fail() RETURNS trigger AS $$ BEGIN IF NEW.jira_worklog_id = 'bad' THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await q("CREATE TRIGGER zz_fail BEFORE INSERT ON worklogs FOR EACH ROW EXECUTE FUNCTION zz_fail()");
    await expect(pass(a, [{ items }])).rejects.toThrow();
    await q("DROP TRIGGER zz_fail ON worklogs");
    await pass(a, [{ items }]);
    expect(await state()).toMatchSnapshot();
  });

  it("an empty page", async () => {
    expect(await pass(a, [{ items: [], gone: [] }])).toEqual({ checkpoint: "c", upserted: 0, removed: 0 });
    expect(await state()).toEqual({ worklogs: [], outbox: [] });
  });
});
