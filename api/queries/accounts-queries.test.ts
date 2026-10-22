// Queries to sign a user out everywhere, by how many sessions it has (docs/dev/measuring.md).
// Counted from the call to its return; the result is checked too: every session and
// remembered device of the user ends, the kept one stays, nobody else's goes.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { countQueries } from "../testing/countQueries";

const q: typeof import("./connection").q = async (text, ...params) => (await import("./connection")).q(text, ...params);

/** Queries by sessions S (one of them kept). Before Wave 2: 2 / 6 / 21 (one delete per session). */
const MEASURED = { 1: 2, 5: 2, 20: 2 } as const;

describe("signOutEverywhere", () => {
  let me = 0;
  let other = 0;

  beforeAll(async () => {
    await (await import("./connection")).resetDbForTests();
    [{ id: me }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('so', 'So', 1) RETURNING id");
    [{ id: other }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('so2', 'So2', 1) RETURNING id");
  });

  for (const s of [1, 5, 20] as const) {
    it(`${s} sessions, one kept`, async () => {
      await q("DELETE FROM sessions");
      await q("DELETE FROM remembered_devices");
      for (let i = 0; i < s; i++) await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, 1)", `s${i}`, me, Date.now() + 86_400_000);
      await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('theirs', ?, ?, 1)", other, Date.now() + 86_400_000);
      await q("INSERT INTO remembered_devices (id, user_id, expires_at, last_used_at, created_at) VALUES ('d-me', ?, ?, 1, 1), ('d-theirs', ?, ?, 1, 1)", me, Date.now() + 86_400_000, other, Date.now() + 86_400_000);
      const { signOutEverywhere } = await import("./accounts");
      const counter = countQueries();
      try {
        await signOutEverywhere(me, "s0");
        console.info(`[measure] signOutEverywhere, ${s} sessions: ${counter.n}`);
        expect(counter.n).toBeLessThanOrEqual(MEASURED[s]);
      } finally {
        counter.stop();
      }
      expect(await q("SELECT id FROM sessions ORDER BY id")).toEqual([{ id: "s0" }, { id: "theirs" }]);
      expect(await q("SELECT id FROM remembered_devices")).toEqual([{ id: "d-theirs" }]);
    });
  }

  it("no session kept, and a user with none: the same, nobody else's touched", async () => {
    await q("DELETE FROM sessions");
    for (let i = 0; i < 3; i++) await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, 1)", `s${i}`, me, Date.now() + 86_400_000);
    await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('theirs', ?, ?, 1)", other, Date.now() + 86_400_000);
    const { signOutEverywhere } = await import("./accounts");
    await signOutEverywhere(me);
    expect(await q("SELECT id FROM sessions")).toEqual([{ id: "theirs" }]);
    await signOutEverywhere(me, "s0");
    expect(await q("SELECT id FROM sessions")).toEqual([{ id: "theirs" }]);
  });
});
