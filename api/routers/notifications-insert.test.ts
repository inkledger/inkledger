// Storing notifications in one statement keeps what storing them one by one kept: a
// repeat within the list leaves the first, a known one is left as it is, any number.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { countQueries } from "../testing/countQueries";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

describe("insertNotifications", () => {
  let userId = 0;
  let conn = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('n', 'N', 1) RETURNING id");
    [{ id: conn }] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://j.example', 'me', '{}', 'x', 1) RETURNING id", userId);
  });

  const n = (key: string, dedupe: string, detail = "") => ({ connectionId: conn, kind: "due" as const, issueKey: key, detail, dedupe });

  it("a repeat in the list leaves the first; a known one stays as it was", async () => {
    const { insertNotifications } = await import("./notifications");
    await insertNotifications(userId, [n("A-1", "d1", "old")], 1000);
    await insertNotifications(userId, [n("A-1", "d1", "new"), n("A-2", "d2", "first"), n("A-2", "d2", "second")], 2000);
    expect(await q("SELECT issue_key, detail, created_at FROM notifications ORDER BY issue_key")).toEqual([
      { issue_key: "A-1", detail: "old", created_at: 1000 },
      { issue_key: "A-2", detail: "first", created_at: 2000 },
    ]);
  });

  it("1200 at once, past one statement's batch: all stored, in as few queries", async () => {
    const { insertNotifications } = await import("./notifications");
    await q("DELETE FROM notifications");
    const many = Array.from({ length: 1200 }, (_, i) => n(`B-${i}`, `m${i}`));
    const counter = countQueries();
    try {
      await insertNotifications(userId, many, 3000);
      expect(counter.n).toBeLessThanOrEqual(5);
    } finally {
      counter.stop();
    }
    expect(await q("SELECT count(*)::int AS c FROM notifications")).toEqual([{ c: 1200 }]);
  });
});
