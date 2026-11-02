// How many database queries one pass of the issue stream costs (the provider
// contract path, api/sync/issues.ts), measured (docs/dev/measuring.md) at several
// page sizes. Counted from the call of syncIssues to its return, with
// api/testing/countQueries. The numbers are the measured ones: lowering one
// lowers it here; raising one is a deliberate edit with its reason in the commit.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { timeZone } from "@contracts/values";
import { unlimited } from "./budget";
import { countQueries } from "../testing/countQueries";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const zone = timeZone("Europe/Rome");
const meta = { signal: new AbortController().signal, correlationId: "t" };

/**
 * Queries per full pass of N issues in one project, one page of N (all new, then
 * all known). Before 2026-11-02 they grew with N, 2 per issue (its container
 * written, then the issue): 24 / 22 at 10, 44 / 42 at 20, 84 / 82 at 40. A page
 * is now written in one statement, each container once per pass.
 */
const MEASURED = {
  allNew: { 10: 5, 20: 5, 40: 5 },
  allKnown: { 10: 3, 20: 3, 40: 3 },
} as const;

describe("queries per pass of the issue stream", () => {
  let userId = 0;
  let connId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('iq', 'Iq', ?) RETURNING id", Date.now());
    userId = u.id;
  });

  beforeEach(async () => {
    await q("DELETE FROM issues WHERE user_id = ?", userId);
    await q("DELETE FROM connections WHERE user_id = ?", userId);
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://fake.example', 'me', '{}', 'x', ?) RETURNING id",
      userId,
      Date.now(),
    );
    connId = c.id;
  });

  async function trackerOf(n: number) {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { bindTracker } = await import("../providers/core/bind");
    const fake = fakeTracker(
      Array.from({ length: n }, (_, i) => ({ key: `FAKE-${i + 1}`, title: `Issue ${i + 1}` })),
      { pageSize: n },
    );
    return bindTracker(fake, { id: connId, userId, type: "gitlab", baseUrl: "https://fake.example", remoteAccountId: "me", options: { region: "eu" }, timeZone: zone, credential: async () => ({ kind: "token", token: "t" }) });
  }

  for (const n of [10, 20, 40] as const) {
    it(`a full pass of ${n} issues, all new then all known`, async () => {
      const { syncIssues } = await import("./issues");
      const b = await trackerOf(n);
      const t = { userId, connectionId: connId };
      const counter = countQueries();
      try {
        const first = await syncIssues(b, t, { since: null, meta, budget: unlimited });
        const allNew = counter.n;
        expect(first.seen).toBe(n);
        counter.reset();
        const again = await syncIssues(b, t, { since: null, meta, budget: unlimited });
        const allKnown = counter.n;
        expect(again).toMatchObject({ seen: n, missing: 0 });
        console.info(`[measure] issue pass of ${n}: allNew=${allNew} allKnown=${allKnown}`);
        const [{ count }] = await q<{ count: number }>("SELECT count(*)::int AS count FROM issues WHERE user_id = ? AND connection_id = ? AND gone_at IS NULL", userId, connId);
        expect(count).toBe(n);
        expect(allNew).toBeLessThanOrEqual(MEASURED.allNew[n]);
        expect(allKnown).toBeLessThanOrEqual(MEASURED.allKnown[n]);
      } finally {
        counter.stop();
      }
    });
  }
});
