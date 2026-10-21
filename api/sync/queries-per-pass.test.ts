// How many database queries one pass of the worklog feed costs, measured
// (docs/dev/measuring.md). Every query reaches PGlite through query(), inside
// a transaction through the transaction's own query(): both are counted. The
// ceilings are the baseline's numbers: a change may lower them, never raise them.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite, type Transaction } from "@electric-sql/pglite";

process.env.DATABASE_URL = ":memory:";

import { timeZone } from "@contracts/values";
import { unlimited } from "./budget";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const zone = timeZone("Europe/Rome");
const meta = { signal: new AbortController().signal, correlationId: "t" };
const ref = { remoteId: "r-1", key: "FAKE-1" };
const N = 20;

/** Ceilings per pass of N entries (baseline 2026-10-21). */
const CEILING = { allNew: 80, allKnown: 80, fiveGone: 10 };

let counted = 0;
/** Counts every query from now on (installed once per test; reset `counted` between passes). */
function countQueries() {
  counted = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with apply/call on the instance below
  const query = PGlite.prototype.query;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- same
  const transaction = PGlite.prototype.transaction;
  vi.spyOn(PGlite.prototype, "query").mockImplementation(function (this: PGlite, ...a: Parameters<PGlite["query"]>) {
    counted++;
    return query.apply(this, a);
  } as PGlite["query"]);
  vi.spyOn(PGlite.prototype, "transaction").mockImplementation(function <T>(this: PGlite, fn: (tx: Transaction) => Promise<T>) {
    return transaction.call(this, (tx: Transaction) => {
      const txQuery = tx.query.bind(tx);
      tx.query = ((...a: Parameters<Transaction["query"]>) => {
        counted++;
        return txQuery(...a);
      }) as Transaction["query"];
      return fn(tx);
    });
  });
}

describe("queries per pass of the worklog feed", () => {
  let userId = 0;
  let connId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('qp', 'Qp', ?) RETURNING id", Date.now());
    userId = u.id;
  });

  beforeEach(async () => {
    await q("DELETE FROM worklogs WHERE user_id = ?", userId);
    await q("DELETE FROM connections WHERE user_id = ?", userId);
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://fake.example', 'me', '{}', 'x', ?) RETURNING id",
      userId,
      Date.now(),
    );
    connId = c.id;
  });

  afterEach(() => vi.restoreAllMocks());

  it("the counter counts one query as one, inside a transaction too", async () => {
    const { getDb } = await import("../queries/connection");
    const { sql } = await import("drizzle-orm");
    countQueries();
    await q("SELECT 1");
    expect(counted).toBe(1);
    counted = 0;
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      await tx.execute(sql`SELECT 2`);
    });
    // The two statements, plus the transaction's own begin/commit when drizzle sends them as queries.
    expect(counted).toBeGreaterThanOrEqual(2);
    expect(counted).toBeLessThanOrEqual(4);
  });

  it(`a pass of ${N} entries: all new, all known, five gone`, async () => {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { bindTracker } = await import("../providers/core/bind");
    const { syncEntries } = await import("./worklogs");
    const fake = fakeTracker([{ key: "FAKE-1", title: "First" }], { pageSize: N });
    const b = bindTracker(fake, { id: connId, userId, type: "gitlab", baseUrl: "https://fake.example", remoteAccountId: "me", options: { region: "eu" }, timeZone: zone, credential: async () => ({ kind: "token", token: "t" }) });
    const conn = { id: connId, userId, remoteAccountId: "me" };
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const e = await b.worklogs!.create!(meta, ref, { time: { kind: "session", start: Date.UTC(2026, 9, 15, 8, i * 10) as never, seconds: 300 }, comment: `e${i}` }, { idempotencyKey: `k${i}` });
      ids.push(e.remoteId);
    }

    countQueries();
    const first = await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
    const allNew = counted;
    expect(first.upserted).toBe(N);

    // A full re-read (no checkpoint): every entry is already ours.
    counted = 0;
    await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
    const allKnown = counted;

    for (const id of ids.slice(0, 5)) await b.worklogs!.delete!(meta, ref, id, {});
    counted = 0;
    const gone = await syncEntries(b, conn, { since: first.checkpoint, meta, budget: unlimited, zone });
    const fiveGone = counted;
    expect(gone.removed).toBe(5);

    console.info(`[measure] queries per pass of ${N}: allNew=${allNew} allKnown=${allKnown} fiveGone=${fiveGone}`);
    expect(allNew).toBeLessThanOrEqual(CEILING.allNew);
    expect(allKnown).toBeLessThanOrEqual(CEILING.allKnown);
    expect(fiveGone).toBeLessThanOrEqual(CEILING.fiveGone);
  });
});
