// A day-totals sink (Everhour) told of a deleted worklog sets the day's total
// again: with the time left on that worklog's own tracker only, never another
// tracker's time that shares its issue key.
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

type Call = { trackerConnectionId: number; key: string; date: string; seconds: number };
const calls = vi.hoisted((): Call[] => []);
vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  const { everhourSink } = await import("../providers/everhour/adapter");
  const sink = {
    ...everhourSink,
    entries: {
      list: async () => [],
      setDayTotal: async (_x: unknown, ref: { trackerConnectionId: number; issue: { key: string } }, _t: unknown, date: string, seconds: number) => {
        calls.push({ trackerConnectionId: ref.trackerConnectionId, key: ref.issue.key, date, seconds });
        return null;
      },
    },
  };
  return { ...real, sinkAdapter: (type: string) => (type === "everhour" ? sink : null), sinkStatus: (type: string) => (type === "everhour" ? "built" : "planned") };
});

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

describe("a day-totals sink after a delete", () => {
  let userId = 0;
  let a = 0;
  let b = 0;
  let sinkId = 0;
  let issueA = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('d', 'D', 1) RETURNING id");
    userId = u.id;
    const conn = async (type: string, base: string) => {
      const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, ?, ?, 'me', '{}', 'x', 1) RETURNING id", userId, type, base);
      await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", c.id), c.id);
      return c.id;
    };
    a = await conn("gitlab", "https://a.example");
    b = await conn("gitlab", "https://b.example");
    sinkId = await conn("everhour", "https://api.everhour.com");
    const issue = async (connectionId: number) =>
      (await q<{ id: number }>("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'r-1', 'FAKE-1', 'Same key', 'To Do', 'FAKE', 'Fake', 'u', 1) RETURNING id", userId, connectionId))[0].id;
    issueA = await issue(a);
    await issue(b);
    await q("INSERT INTO sink_mappings (sink_connection_id, container_id, target_remote_id, target_name, target_path, activity_id) VALUES (?, NULL, 't-1', 'Build', '[]', NULL)", sinkId);
    const day = Date.parse("2026-10-21T09:00:00+02:00");
    const wl = (connectionId: number, remoteId: string, seconds: number) =>
      q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'FAKE-1', ?, ?, ?, '', 1)", userId, connectionId, remoteId, seconds, day);
    // Left on A after the delete: 30 min. On B, the same key: 2 h.
    await wl(a, "a-left", 1800);
    await wl(b, "b-1", 7200);
  });

  it("A's day is set again with A's time only", async () => {
    const started = Date.parse("2026-10-21T10:00:00+02:00");
    // A's deleted worklog: its sink delete, due (no worklog holds it), tied to A's issue.
    await q("INSERT INTO outbox (user_id, connection_id, item_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, created_at) VALUES (?, ?, ?, 'delete', 'FAKE-1', 'ev-1', 3600, ?, 1)", userId, sinkId, issueA, started);
    await (await import("./extraSinks")).pushSinks(userId);
    expect(calls).toEqual([{ trackerConnectionId: a, key: "FAKE-1", date: "2026-10-21", seconds: 1800 }]);
  });
});
