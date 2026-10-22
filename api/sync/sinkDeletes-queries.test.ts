// Queries of one sinks pass that sends D deletes to a day-totals sink (Everhour), by D
// (docs/dev/measuring.md). Counted from the call of pushSinks to its return. The result
// is checked too: each delete sets its day's total to the time left on its own tracker.
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { countQueries } from "../testing/countQueries";

type Call = { key: string; date: string; seconds: number; tracker?: number };
const calls = vi.hoisted((): Call[] => []);
/** The call (0-based) at which the sink answers "unavailable" (a transient failure), or none. */
const failAt = vi.hoisted(() => ({ call: -1 }));
vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  const { everhourSink } = await import("../providers/everhour/adapter");
  const sink = {
    ...everhourSink,
    entries: {
      list: async () => [],
      setDayTotal: async (_x: unknown, ref: { trackerConnectionId: number; issue: { key: string } }, _t: unknown, date: string, seconds: number) => {
        if (calls.length === failAt.call) {
          const { ProviderError } = await import("../providers/core/errors");
          throw new ProviderError("unavailable", "down for a moment");
        }
        calls.push({ key: ref.issue.key, date, seconds, tracker: ref.trackerConnectionId });
        return null;
      },
    },
  };
  return { ...real, sinkAdapter: (type: string) => (type === "everhour" ? sink : null), sinkStatus: (type: string) => (type === "everhour" ? "built" : "planned") };
});

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

/** Queries by deletes D (all on one issue, one day). Before Wave 2: 9 / 29 / 104 (4 + 5 per delete). */
const MEASURED = { 1: 9, 5: 9, 20: 9 } as const;

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
      expect(calls).toEqual(Array.from({ length: d }, () => ({ key: "FAKE-1", date: "2026-10-21", seconds: 1800, tracker })));
      expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    });
  }

  const queue = async (n: number, opts: { issue?: number; key?: string; from?: number } = {}) => {
    const started = Date.parse("2026-10-21T10:00:00+02:00");
    for (let i = 0; i < n; i++) {
      const at = (opts.from ?? 0) + i;
      await q("INSERT INTO outbox (user_id, connection_id, item_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, created_at) VALUES (?, ?, ?, 'delete', ?, ?, 600, ?, ?)", userId, sinkId, opts.issue ?? issueId, opts.key ?? "FAKE-1", `ev-${at}`, started, at + 1);
    }
  };
  const left = () => q<{ id: string; claimed: boolean; attempts: number }>("SELECT jira_worklog_id AS id, claimed_at IS NOT NULL AS claimed, attempts FROM outbox ORDER BY created_at");

  it("the sink out of reach halfway: what was sent goes, the rest is let go untouched for the next pass", async () => {
    calls.length = 0;
    await q("DELETE FROM outbox");
    await queue(5);
    failAt.call = 2;
    try {
      const { pushSinks } = await import("./extraSinks");
      expect(await pushSinks(userId)).toEqual({ sent: 2, failed: 0 });
    } finally {
      failAt.call = -1;
    }
    expect(await left()).toEqual(["ev-2", "ev-3", "ev-4"].map((id) => ({ id, claimed: false, attempts: 0 })));
    const { pushSinks } = await import("./extraSinks");
    expect(await pushSinks(userId)).toEqual({ sent: 3, failed: 0 });
    expect(await left()).toEqual([]);
  });

  it("a delete another server process has just claimed is left to it", async () => {
    calls.length = 0;
    await q("DELETE FROM outbox");
    await queue(3);
    await q("UPDATE outbox SET claimed_at = ? WHERE jira_worklog_id = 'ev-1'", Date.now());
    const { pushSinks } = await import("./extraSinks");
    expect(await pushSinks(userId)).toEqual({ sent: 2, failed: 0 });
    expect(await left()).toEqual([{ id: "ev-1", claimed: true, attempts: 0 }]);
  });

  it("more than a pass takes (150): 100 now, in as many queries as 1, the rest on the next pass", async () => {
    calls.length = 0;
    await q("DELETE FROM outbox");
    await queue(150);
    const { pushSinks } = await import("./extraSinks");
    const counter = countQueries();
    try {
      expect(await pushSinks(userId)).toEqual({ sent: 100, failed: 0 });
      expect(counter.n).toBeLessThanOrEqual(MEASURED[1]);
    } finally {
      counter.stop();
    }
    expect((await left()).map((r) => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => `ev-${100 + i}`));
    expect(await pushSinks(userId)).toEqual({ sent: 50, failed: 0 });
  });

  it("deletes of two issues on two trackers: each day's total counts its own tracker's time", async () => {
    calls.length = 0;
    await q("DELETE FROM outbox");
    const { sealSecret } = await import("../lib/crypto");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://b.example', 'me', '{}', 'x', 1) RETURNING id", userId);
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", c.id), c.id);
    const [other] = await q<{ id: number }>("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'r-b', 'FAKE-1', 'Same key', 'To Do', 'FAKE', 'Fake', 'u', 1) RETURNING id", userId, c.id);
    // On B, the same key: 2 h that day.
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'FAKE-1', 'b-left', 7200, ?, '', 1)", userId, c.id, Date.parse("2026-10-21T11:00:00+02:00"));
    await queue(2);
    await queue(2, { issue: other.id, from: 2 });
    const { pushSinks } = await import("./extraSinks");
    expect(await pushSinks(userId)).toEqual({ sent: 4, failed: 0 });
    expect(calls.map((x) => [x.tracker, x.seconds])).toEqual([[tracker, 1800], [tracker, 1800], [c.id, 7200], [c.id, 7200]]);
  });

  it("nothing to send: no claim at all", async () => {
    calls.length = 0;
    await q("DELETE FROM outbox");
    const { pushSinks } = await import("./extraSinks");
    expect(await pushSinks(userId)).toEqual({ sent: 0, failed: 0 });
    expect(calls).toEqual([]);
  });
});
