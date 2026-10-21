// A time sink's delete that keeps failing: it waits its turn (persisted, so a
// pass doesn't pick it again before its time), stops at the attempts cap (kept,
// shown as stuck), goes oldest first in bounded batches, and is claimed so a
// second server process on the same database never sends it twice.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const fakes = vi.hoisted((): { sink: unknown } => ({ sink: null }));
vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  return {
    ...real,
    sinkAdapter: (type: string) => (type === "harvest" ? fakes.sink : null),
    sinkStatus: (type: string) => (type === "harvest" ? "built" : "planned"),
  };
});

import { MAX_OUTBOX_ATTEMPTS } from "@contracts/types";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

describe("a time sink's failed delete, retried", () => {
  let userId = 0;
  let sinkId = 0;
  let calls: string[] = [];
  let refuse = true;
  const T0 = Date.UTC(2026, 9, 21, 10);

  beforeAll(async () => {
    const { fakeSink } = await import("../providers/fake/adapter");
    const { ProviderError } = await import("../providers/core/errors");
    const sink = fakeSink();
    sink.entries.delete = async (_x, remoteId) => {
      calls.push(remoteId);
      if (refuse) throw new ProviderError("invalid", "the sink refuses");
    };
    fakes.sink = sink;
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('r', 'R', 1) RETURNING id");
    userId = u.id;
    const [s] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'harvest', 'https://sink.example', 'me', '{}', 'x', 1) RETURNING id", u.id);
    sinkId = s.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("k", s.id), s.id);
  });

  beforeEach(async () => {
    calls = [];
    refuse = true;
    await q("DELETE FROM outbox");
  });

  const queue = (remoteId: string, extra: { attempts?: number; createdAt?: number; claimedAt?: number | null } = {}) =>
    q(
      "INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, attempts, claimed_at, created_at) VALUES (?, ?, 'delete', 'FAKE-1', ?, ?, ?, ?)",
      userId,
      sinkId,
      remoteId,
      extra.attempts ?? 0,
      extra.claimedAt ?? null,
      extra.createdAt ?? T0,
    );
  const row = async (remoteId: string) =>
    (await q<{ attempts: number; next_attempt_at: number | null; claimed_at: number | null; last_error: string }>("SELECT attempts, next_attempt_at, claimed_at, last_error FROM outbox WHERE jira_worklog_id = ?", remoteId))[0];
  const pass = async (at: number) => (await import("./extraSinks")).pushSinks(userId, () => at);

  it("a failure waits its delay, persisted: the next pass leaves it alone, one after the wait tries again", async () => {
    const { deleteRetryDelayMs } = await import("./extraSinks");
    await queue("e-1");
    await pass(T0);
    expect(calls).toEqual(["e-1"]);
    expect(await row("e-1")).toMatchObject({ attempts: 1, next_attempt_at: T0 + deleteRetryDelayMs(1), claimed_at: null, last_error: "the sink refuses" });
    expect(deleteRetryDelayMs(1)).toBe(60_000);

    calls = [];
    await pass(T0 + deleteRetryDelayMs(1) - 1);
    expect(calls).toEqual([]);

    await pass(T0 + deleteRetryDelayMs(1));
    expect(calls).toEqual(["e-1"]);
    expect(await row("e-1")).toMatchObject({ attempts: 2, next_attempt_at: T0 + deleteRetryDelayMs(1) + deleteRetryDelayMs(2) });
    expect(deleteRetryDelayMs(2)).toBe(120_000);
  });

  it("the wait grows, at most an hour", async () => {
    const { deleteRetryDelayMs } = await import("./extraSinks");
    expect([1, 2, 3, 4, 9].map(deleteRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 3_600_000]);
  });

  it("at the attempts cap it is never tried again, and stays (shown as stuck)", async () => {
    await queue("e-cap", { attempts: MAX_OUTBOX_ATTEMPTS });
    await queue("e-last", { attempts: MAX_OUTBOX_ATTEMPTS - 1 });
    await pass(T0);
    expect(calls).toEqual(["e-last"]);
    expect(await row("e-last")).toMatchObject({ attempts: MAX_OUTBOX_ATTEMPTS });
    calls = [];
    await pass(T0 + 24 * 3_600_000);
    expect(calls).toEqual([]);
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 2 }]);
  });

  it("a delete that goes through leaves the queue", async () => {
    refuse = false;
    await queue("e-ok");
    await pass(T0);
    expect(calls).toEqual(["e-ok"]);
    expect(await row("e-ok")).toBeUndefined();
  });

  it("oldest first", async () => {
    await queue("e-new", { createdAt: T0 + 2000 });
    await queue("e-old", { createdAt: T0 });
    await queue("e-mid", { createdAt: T0 + 1000 });
    await pass(T0 + 5000);
    expect(calls).toEqual(["e-old", "e-mid", "e-new"]);
  });

  it("one another process holds is left to it; a claim left behind (older than its lease) is taken over", async () => {
    const { CLAIM_TTL_MS } = await import("./timeWrites");
    await queue("e-held", { claimedAt: T0 - 1000 });
    await queue("e-stale", { claimedAt: T0 - CLAIM_TTL_MS - 1 });
    await pass(T0);
    expect(calls).toEqual(["e-stale"]);
    expect(await row("e-held")).toMatchObject({ attempts: 0, claimed_at: T0 - 1000 });
  });

  it("two passes at once for the same user never send the same delete twice", async () => {
    refuse = false;
    for (let i = 0; i < 5; i++) await queue(`e-${i}`, { createdAt: T0 + i });
    // The same user (the in-process guard), and the claim (another process on the same database).
    const { pushSinks } = await import("./extraSinks");
    await Promise.all([pushSinks(userId, () => T0 + 10), pushSinks(userId, () => T0 + 10)]);
    expect([...calls].sort()).toEqual(["e-0", "e-1", "e-2", "e-3", "e-4"]);
  });
});
