// How many database queries one pass of the worklog feed costs, measured
// (docs/dev/measuring.md) at several page sizes: the count per pass, and how it
// grows with the page. Counted from the call of syncEntries to its return, with
// api/testing/countQueries (every query on PGlite, inside transactions too).
// The numbers are the measured ones: a change may lower them, never raise them.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { timeZone } from "@contracts/values";
import { unlimited } from "./budget";
import { countQueries } from "../testing/countQueries";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const zone = timeZone("Europe/Rome");
const meta = { signal: new AbortController().signal, correlationId: "t" };
const ref = { remoteId: "r-1", key: "FAKE-1" };

/**
 * Queries per pass, by page size N (all new, all known) and by entries gone G (of 40).
 * Before Wave 2 (frozen 2026-10-22): 40 / 80 / 160 for both, and 10 / 20 / 40 gone
 * (4 per entry, 2 per entry gone). A page is now read once and written in a few
 * statements: the same at any size.
 */
const MEASURED = {
  allNew: { 10: 4, 20: 4, 40: 4 },
  allKnown: { 10: 4, 20: 4, 40: 4 },
  gone: { 5: 2, 10: 2, 20: 2 },
} as const;

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

  it("the counter counts one query as one, inside a transaction too", async () => {
    const { getDb } = await import("../queries/connection");
    const { sql } = await import("drizzle-orm");
    const counter = countQueries();
    try {
      await q("SELECT 1");
      expect(counter.n).toBe(1);
      counter.reset();
      await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await tx.execute(sql`SELECT 2`);
      });
      // The two statements, plus the transaction's own begin/commit when drizzle sends them as queries.
      expect(counter.n).toBeGreaterThanOrEqual(2);
      expect(counter.n).toBeLessThanOrEqual(4);
    } finally {
      counter.stop();
    }
  });

  /** A fake tracker with `n` entries of the user's on one issue, one page of `n`; the feed and the entry ids. */
  async function feedOf(n: number) {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { bindTracker } = await import("../providers/core/bind");
    const fake = fakeTracker([{ key: "FAKE-1", title: "First" }], { pageSize: n });
    const b = bindTracker(fake, { id: connId, userId, type: "gitlab", baseUrl: "https://fake.example", remoteAccountId: "me", options: { region: "eu" }, timeZone: zone, credential: async () => ({ kind: "token", token: "t" }) });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const e = await b.worklogs!.create!(meta, ref, { time: { kind: "session", start: Date.UTC(2026, 9, 15, 8, i * 10) as never, seconds: 300 }, comment: `e${i}` }, { idempotencyKey: `k${i}` });
      ids.push(e.remoteId);
    }
    return { b, ids, conn: { id: connId, userId, remoteAccountId: "me" } };
  }

  it("a pass of 20 entries: all new, all known, five gone", async () => {
    const { syncEntries } = await import("./worklogs");
    const { b, ids, conn } = await feedOf(20);
    const counter = countQueries();
    try {
      const first = await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
      expect(first.upserted).toBe(20);
      expect(counter.n).toBeLessThanOrEqual(MEASURED.allNew[20]);
      counter.reset();
      await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
      expect(counter.n).toBeLessThanOrEqual(MEASURED.allKnown[20]);
      for (const id of ids.slice(0, 5)) await b.worklogs!.delete!(meta, ref, id, {});
      counter.reset();
      const gone = await syncEntries(b, conn, { since: first.checkpoint, meta, budget: unlimited, zone });
      expect(gone.removed).toBe(5);
      expect(counter.n).toBeLessThanOrEqual(MEASURED.gone[5]);
    } finally {
      counter.stop();
    }
  });

  for (const n of [10, 20, 40] as const) {
    it(`a pass of ${n} entries, all new then all known`, async () => {
      const { syncEntries } = await import("./worklogs");
      const { b, conn } = await feedOf(n);
      const counter = countQueries();
      try {
        const first = await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
        const allNew = counter.n;
        expect(first.upserted).toBe(n);
        // A full re-read (no checkpoint): every entry is already ours.
        counter.reset();
        await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
        const allKnown = counter.n;
        console.info(`[measure] pass of ${n}: allNew=${allNew} allKnown=${allKnown}`);
        expect(allNew).toBeLessThanOrEqual(MEASURED.allNew[n]);
        expect(allKnown).toBeLessThanOrEqual(MEASURED.allKnown[n]);
      } finally {
        counter.stop();
      }
    });
  }

  for (const g of [5, 10, 20] as const) {
    it(`a pass where ${g} of 40 entries are gone`, async () => {
      const { syncEntries } = await import("./worklogs");
      const { b, ids, conn } = await feedOf(40);
      const first = await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
      for (const id of ids.slice(0, g)) await b.worklogs!.delete!(meta, ref, id, {});
      const counter = countQueries();
      try {
        const gone = await syncEntries(b, conn, { since: first.checkpoint, meta, budget: unlimited, zone });
        expect(gone.removed).toBe(g);
        console.info(`[measure] ${g} of 40 gone: ${counter.n}`);
        expect(counter.n).toBeLessThanOrEqual(MEASURED.gone[g]);
      } finally {
        counter.stop();
      }
    });
  }
});
