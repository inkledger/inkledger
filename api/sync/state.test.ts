import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

import type { Checkpoint } from "../providers/types";

type Q = typeof import("../queries/connection").q;
const q: Q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

describe("a sync stream's lease across processes", () => {
  let connId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('ls', 'Ls', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'github', 'https://fake.example', 'me', '{}', 'x', 1) RETURNING id", u.id);
    connId = c.id;
  });

  beforeEach(() => q("DELETE FROM connection_sync"));

  it("a pass whose lease another process took over (past its expiry) records nothing and says so", async () => {
    const { withStream } = await import("./engine");
    await q("INSERT INTO connection_sync (connection_id, stream, checkpoint) VALUES (?, 'issues', 'old')", connId);
    const run = withStream({ id: connId }, "issues", { full: false, background: true }, async () => {
      // Meanwhile the lease ran out and another process holds the stream.
      await q("UPDATE connection_sync SET lease_owner = 'other', lease_until = ? WHERE connection_id = ?", Date.now() + 600_000, connId);
      return { result: 1, checkpoint: "mine" as Checkpoint };
    });
    await expect(run).rejects.toThrow(/lease/i);
    expect(await q("SELECT checkpoint, lease_owner FROM connection_sync WHERE connection_id = ?", connId)).toEqual([{ checkpoint: "old", lease_owner: "other" }]);
  });

  it("a long pass keeps its lease alive (heartbeat), so no other process takes the stream meanwhile", async () => {
    const { withStream } = await import("./engine");
    const { HEARTBEAT_MS, LEASE_MS } = await import("./state");
    expect(HEARTBEAT_MS).toBeLessThan(LEASE_MS / 2);
    let until0 = 0;
    let until1 = 0;
    // The heartbeat's clock only: the database keeps its real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.now() });
    try {
      await withStream({ id: connId }, "issues", { full: false, background: true }, async () => {
        [{ until: until0 }] = await q<{ until: number }>("SELECT lease_until AS until FROM connection_sync WHERE connection_id = ?", connId);
        vi.advanceTimersByTime(HEARTBEAT_MS + 1);
        await new Promise((r) => setTimeout(r, 100));
        [{ until: until1 }] = await q<{ until: number }>("SELECT lease_until AS until FROM connection_sync WHERE connection_id = ?", connId);
        return { result: 1 };
      });
    } finally {
      vi.useRealTimers();
    }
    expect(Number(until1)).toBeGreaterThan(Number(until0));
  });
});
