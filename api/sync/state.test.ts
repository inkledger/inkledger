import { beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

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

describe("a connection out of reach too many times in a row", () => {
  let connId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('gu', 'Gu', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://fake.example', 'me', '{}', 'x', 1) RETURNING id", u.id);
    connId = c.id;
  });

  beforeEach(async () => {
    await q("DELETE FROM connection_sync");
    await q("UPDATE connections SET status = 'ok' WHERE id = ?", connId);
  });

  const fail = async (times: number, error: unknown = new TypeError("fetch failed")) => {
    const { acquire, failed } = await import("./state");
    for (let i = 0; i < times; i++) {
      const got = await acquire(connId, "issues", Date.now(), { ignoreWait: true });
      expect(got.ok).toBe(true);
      await failed(connId, "issues", error);
    }
  };
  const status = async () => (await q<{ status: string }>("SELECT status FROM connections WHERE id = ?", connId))[0].status;

  it("unreachable after SYNC_GIVE_UP_AFTER, still retried with a backoff of at most 6 hours", async () => {
    const { SYNC_GIVE_UP_AFTER } = await import("@contracts/sync");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fail(SYNC_GIVE_UP_AFTER - 1);
      expect(await status()).toBe("ok");
      await fail(1);
      expect(await status()).toBe("unreachable");
      // Said once, on the way in: a later failure (the user's own Sync) adds no line.
      await fail(1);
      expect(warn.mock.calls.filter(([m]) => String(m).includes("unreachable after")).length).toBe(1);
      // Then longer and longer, at most 6 hours.
      const waitMin = async () => Math.round((Number((await q<{ r: number }>("SELECT retry_after r FROM connection_sync WHERE connection_id = ?", connId))[0].r) - Date.now()) / 60_000);
      await fail(10 - SYNC_GIVE_UP_AFTER - 1);
      expect(await waitMin()).toBe(256);
      await fail(2);
      expect(await waitMin()).toBe(360);
    } finally {
      warn.mockRestore();
    }
  });

  it("records why it failed, never empty: kind, the status Jira answered, its words", async () => {
    const { JiraApiError } = await import("../jira/client");
    const lastError = async () => (await q<{ e: string }>("SELECT last_error e FROM connection_sync WHERE connection_id = ?", connId))[0].e;
    await fail(1, new JiraApiError(503, ""));
    expect(await lastError()).toBe("unavailable (503)");
    await fail(1, new TypeError("fetch failed"));
    expect(await lastError()).toBe("unavailable: fetch failed");
  });

  it("a refusal Jira answered is no outage: 401 waits to be reconnected, another refusal backs off but stays working", async () => {
    const { SYNC_GIVE_UP_AFTER } = await import("@contracts/sync");
    const { JiraApiError } = await import("../jira/client");
    await fail(SYNC_GIVE_UP_AFTER, new JiraApiError(403, "Forbidden"));
    expect(await status()).toBe("ok");
    const [s] = await q<{ r: number | null }>("SELECT retry_after r FROM connection_sync WHERE connection_id = ?", connId);
    expect(Number(s.r)).toBeGreaterThan(Date.now());
    await fail(1, new JiraApiError(401, "Unauthorized"));
    expect(await status()).toBe("auth_failed");
  });

  it("a rate limit with no Retry-After backs off like any failure", async () => {
    const { JiraApiError } = await import("../jira/client");
    await fail(5, new JiraApiError(429, "Too many requests"));
    const [s] = await q<{ r: number }>("SELECT retry_after r FROM connection_sync WHERE connection_id = ?", connId);
    expect(Math.round((Number(s.r) - Date.now()) / 60_000)).toBe(8);
  });

  it("never covers refused credentials", async () => {
    const { SYNC_GIVE_UP_AFTER } = await import("@contracts/sync");
    await q("UPDATE connections SET status = 'auth_failed' WHERE id = ?", connId);
    await fail(SYNC_GIVE_UP_AFTER + 1);
    expect(await status()).toBe("auth_failed");
  });

  it("is ok again once a pass goes through", async () => {
    const { SYNC_GIVE_UP_AFTER } = await import("@contracts/sync");
    const { acquire, succeeded } = await import("./state");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await fail(SYNC_GIVE_UP_AFTER);
    expect(await status()).toBe("unreachable");
    expect((await acquire(connId, "issues", Date.now(), { ignoreWait: true })).ok).toBe(true);
    await succeeded(connId, "issues", { full: false });
    expect(await status()).toBe("ok");
    vi.mocked(console.warn).mockRestore();
  });
});

describe("a failure as last_error records it", () => {
  it("the app reads its kind and status back, for every kind", async () => {
    const { failureText } = await import("./state");
    const { ProviderError } = await import("../providers/core/errors");
    const { FAILURE_KINDS, failureOf } = await import("@contracts/sync");
    expectTypeOf<(typeof FAILURE_KINDS)[number]>().toEqualTypeOf<import("../providers/core/errors").ProviderErrorKind>();
    for (const kind of FAILURE_KINDS) {
      expect(failureOf(failureText(new ProviderError(kind, "Said: words", { status: 503 }))), kind).toEqual({ kind, status: 503, signInDenied: false });
      expect(failureOf(failureText(new ProviderError(kind, ""))), kind).toEqual({ kind, signInDenied: false });
    }
  });
});
