// The estimate revision (docs/work/ideas/estimates.md R-3.15): one atomic statement, a bigint never read as a number.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("./connection").q = async (text, ...params) => (await import("./connection")).q(text, ...params);

describe("estimate revision", () => {
  let me = 0;

  beforeAll(async () => {
    await (await import("./connection")).resetDbForTests();
    [{ id: me }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('rev', 'Rev', 1) RETURNING id");
  });

  it("two raises at once both count", async () => {
    const { estimateRevision, raiseEstimateRevision } = await import("./estimateRevision");
    const { getDb } = await import("./connection");
    // No row yet: both raises race to create it (PGlite has one connection, so they interleave, not overlap).
    await Promise.all([raiseEstimateRevision(getDb(), me), raiseEstimateRevision(getDb(), me)]);
    const revision = await estimateRevision(me);
    expect(typeof revision).toBe("bigint");
    expect(revision).toBe(2n);
  });
});
