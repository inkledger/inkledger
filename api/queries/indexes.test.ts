// Indexes the queries rely on, checked by the plan Postgres (PGlite) picks on a filled
// table. A plan shows the index is usable and chosen here, not how fast production is.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("./connection").q = async (text, ...params) => (await import("./connection")).q(text, ...params);

const plan = async (sqlText: string) => (await q<{ "QUERY PLAN": string }>(`EXPLAIN ${sqlText}`)).map((r) => r["QUERY PLAN"]).join("\n");

describe("indexes", () => {
  let worklogId = 0;

  beforeAll(async () => {
    await (await import("./connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('ix', 'Ix', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://x.example', 'me', '{}', 'x', 1) RETURNING id", u.id);
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) SELECT ?, ?, 'K-1', 'w' || g, 1, 60, '', 1 FROM generate_series(1, 5000) g",
      u.id,
      c.id,
    );
    [{ id: worklogId }] = await q<{ id: number }>("SELECT min(id) AS id FROM worklogs");
    // Queued operations on 5000 worklogs, and as many sink deletes no longer tied to one.
    await q("INSERT INTO outbox (user_id, connection_id, kind, issue_key, worklog_id, created_at) SELECT ?, ?, 'update', 'K-1', w.id, 1 FROM worklogs w", u.id, c.id);
    await q("INSERT INTO outbox (user_id, connection_id, kind, issue_key, worklog_id, created_at) SELECT ?, ?, 'delete', 'K-1', NULL, 1 FROM generate_series(1, 5000)", u.id, c.id);
    await q("ANALYZE outbox");
  });

  it("a worklog's queued operations are found by index (and its delete clears them so: ON DELETE SET NULL)", async () => {
    const p = await plan(`SELECT id FROM outbox WHERE worklog_id = ${worklogId}`);
    expect(p).toMatch(/Index.*idx_outbox_worklog/);
    expect(p).not.toMatch(/Seq Scan/);
  });
});
