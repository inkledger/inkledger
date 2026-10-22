// Queries of one sinks pass that sends D deletes to a day-totals sink (Everhour), by D
// (docs/dev/measuring.md). Counted from the call of pushSinks to its return. The result
// is checked too: each delete sets its day's total to the time left on its own tracker.
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { countQueries } from "../testing/countQueries";

type Call = { key: string; date: string; seconds: number };
const calls = vi.hoisted((): Call[] => []);
vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  const { everhourSink } = await import("../providers/everhour/adapter");
  const sink = {
    ...everhourSink,
    entries: {
      list: async () => [],
      setDayTotal: async (_x: unknown, ref: { issue: { key: string } }, _t: unknown, date: string, seconds: number) => {
        calls.push({ key: ref.issue.key, date, seconds });
        return null;
      },
    },
  };
  return { ...real, sinkAdapter: (type: string) => (type === "everhour" ? sink : null), sinkStatus: (type: string) => (type === "everhour" ? "built" : "planned") };
});

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

/** Queries by deletes D (all on one issue, one day). Frozen 2026-10-22, before Wave 2. */
const MEASURED = { 1: 9, 5: 29, 20: 104 } as const;

describe("a day-totals sink told of D deletes", () => {
  let userId = 0;
  let tracker = 0;
  let sinkId = 0;
  let issueId = 0;

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
    tracker = await conn("gitlab", "https://a.example");
    sinkId = await conn("everhour", "https://api.everhour.com");
    [{ id: issueId }] = await q<{ id: number }>("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'r-1', 'FAKE-1', 'One', 'To Do', 'FAKE', 'Fake', 'u', 1) RETURNING id", userId, tracker);
    await q("INSERT INTO sink_mappings (sink_connection_id, container_id, target_remote_id, target_name, target_path, activity_id) VALUES (?, NULL, 't-1', 'Build', '[]', NULL)", sinkId);
    // Left on the tracker that day: 30 min.
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'FAKE-1', 'left', 1800, ?, '', 1)", userId, tracker, Date.parse("2026-10-21T09:00:00+02:00"));
  });

  for (const d of [1, 5, 20] as const) {
    it(`${d} deletes`, async () => {
      calls.length = 0;
      await q("DELETE FROM outbox");
      const started = Date.parse("2026-10-21T10:00:00+02:00");
      for (let i = 0; i < d; i++) {
        await q("INSERT INTO outbox (user_id, connection_id, item_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, created_at) VALUES (?, ?, ?, 'delete', 'FAKE-1', ?, 600, ?, ?)", userId, sinkId, issueId, `ev-${i}`, started, i + 1);
      }
      const { pushSinks } = await import("./extraSinks");
      const counter = countQueries();
      try {
        expect(await pushSinks(userId)).toEqual({ sent: d, failed: 0 });
        console.info(`[measure] pushSinks, ${d} day-total deletes: ${counter.n}`);
        expect(counter.n).toBeLessThanOrEqual(MEASURED[d]);
      } finally {
        counter.stop();
      }
      expect(calls).toEqual(Array.from({ length: d }, () => ({ key: "FAKE-1", date: "2026-10-21", seconds: 1800 })));
      expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    });
  }
});
