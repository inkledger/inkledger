import { describe, expect, it } from "vitest";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// The rules the database applies to every write (drizzle/0000_baseline.sql,
// "The rules every write follows"), whatever path writes.

/** A migrated database: Ann (user 1, one Jira) with WEB-2 and WEB-3, Bob (user 2) with his own WEB-2. */
async function database() {
  const client = new PGlite({ extensions: { pg_trgm } });
  await migrate(drizzle(client), { migrationsFolder: path.join(import.meta.dirname, "../../drizzle") });
  const q = async (text: string, ...params: unknown[]) => (await client.query(text, params)).rows as Record<string, unknown>[];
  const one = async (text: string, ...params: unknown[]) => (await q(text, ...params))[0];
  const now = Date.now();
  await q("INSERT INTO users (id, email, display_name, created_at) VALUES (1, 'ann@example.com', 'Ann', $1), (2, 'bob@example.com', 'Bob', $1)", now);
  await q("SELECT setval(pg_get_serial_sequence('users', 'id'), 2)");
  await q(
    `INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, legacy, created_at) VALUES
     (1, 'jira', 'https://ann.atlassian.net', 'acc-1', '{}', 'enc-1', 1, $1),
     (2, 'jira', 'https://bob.atlassian.net', 'acc-2', '{}', 'enc-2', 1, $1)`,
    now,
  );
  const issue = (user: number, remoteId: string, key: string) =>
    q("INSERT INTO issues (user_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES ($1, $2, $3, 's', 'To Do', 'WEB', 'Web', 'u', $4)", user, remoteId, key, now);
  await issue(1, "10002", "WEB-2");
  await issue(1, "10003", "WEB-3");
  await issue(2, "20002", "WEB-2");
  const worklog = (user: number, key: string, remote: string, seconds: number) =>
    q("INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES ($1, $2, $3, $4, $5, $5)", user, key, remote, seconds, now);
  await worklog(1, "WEB-2", "502", 7200);
  await worklog(1, "WEB-2", "pending-1", 2700);
  await worklog(2, "WEB-2", "900", 3600);
  await q("INSERT INTO outbox (user_id, kind, issue_key, time_spent_seconds, started, comment, attempts, created_at) VALUES (1, 'create', 'WEB-2', 2700, $1, 'offline', 1, $1)", now);
  await q("INSERT INTO pinboards (id, user_id, name, position, created_at) VALUES (1, 1, 'Board', 0, $1)", now);
  await q("INSERT INTO pinboard_notes (user_id, board_id, issue_key, note, x, y, created_at, updated_at) VALUES (1, 1, 'WEB-2', '', 10, 10, $1, $1)", now);
  return { q, one, close: () => client.close() };
}

describe("rules for every write", () => {
  it("an account carries no credentials: a new one has no connection until it adds one", async () => {
    const { q, close } = await database();
    await q("INSERT INTO users (email, display_name, created_at) VALUES ('cy@example.com', 'Cy', 1)");
    expect(await q("SELECT c.id FROM connections c JOIN users u ON u.id = c.user_id WHERE u.display_name = 'Cy'")).toEqual([]);
    const columns = await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
    expect(columns.map((c) => c.column_name)).not.toContain("encrypted_token");
    await close();
  });

  it("a row written without its connection gets the user's only one, linked to its issue", async () => {
    const { q, one, close } = await database();
    await q("INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (1, 'WEB-3', '777', 60, 1, 1)");
    const web3 = await one("SELECT id, connection_id FROM issues WHERE user_id = 1 AND key = 'WEB-3'");
    expect(await one("SELECT connection_id, item_id FROM worklogs WHERE jira_worklog_id = '777'")).toEqual({ connection_id: web3.connection_id, item_id: web3.id });
    await close();
  });

  it("with two connections, a row takes its issue's connection; a key on none or both must say which", async () => {
    const { q, one, close } = await database();
    const { id: first } = (await one("SELECT connection_id AS id FROM issues WHERE user_id = 1 AND key = 'WEB-3'")) as { id: number };
    const { id: other } = (await one("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (1, 'jira', 'https://other.example', 'a2', 'x', 1) RETURNING id")) as { id: number };
    await q("INSERT INTO timers (user_id, issue_key, started_at, created_at, updated_at) VALUES (1, 'WEB-3', 1, 1, 1)");
    expect(await one("SELECT connection_id FROM timers WHERE issue_key = 'WEB-3'")).toEqual({ connection_id: first });
    await expect(q("INSERT INTO timers (user_id, issue_key, started_at, created_at, updated_at) VALUES (1, 'NOPE-1', 1, 1, 1)")).rejects.toThrow(/connection_id is required/);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (1, $1, '777', 'WEB-3', 's', 'To Do', 'WEB', 'Web', 'u', 1)", other);
    await expect(q("INSERT INTO issue_notes (user_id, issue_key, body, created_at, updated_at) VALUES (1, 'WEB-3', 'n', 1, 1)")).rejects.toThrow(/connection_id is required/);
    await expect(q("INSERT INTO issues (user_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (1, '778', 'WEB-9', 's', 'To Do', 'WEB', 'Web', 'u', 1)")).rejects.toThrow(/connection_id is required/);
    await close();
  });

  it("an issue imported after its worklog picks the worklog up", async () => {
    const { q, one, close } = await database();
    await q("INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (1, 'GONE-9', '901', 60, 1, 1)");
    await q("INSERT INTO issues (user_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (1, '10009', 'GONE-9', 's', 'To Do', 'GONE', 'Gone', 'u', 1)");
    const gone = await one("SELECT id FROM issues WHERE key = 'GONE-9'");
    expect(await one("SELECT item_id FROM worklogs WHERE issue_key = 'GONE-9'")).toEqual({ item_id: gone.id });
    await close();
  });

  it("an issue that changes key takes its rows along and keeps the old key as an alias", async () => {
    const { q, one, close } = await database();
    const web2 = await one("SELECT id FROM issues WHERE user_id = 1 AND key = 'WEB-2'");
    // Something already filed under the new key before the move (not linked yet): the linked rows win.
    await q("INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (1, 'MOB-2', '502', 7200, 1, 1)");
    await q("UPDATE issues SET key = 'MOB-2' WHERE id = $1", web2.id);
    expect(await q("SELECT issue_key, jira_worklog_id FROM worklogs WHERE item_id = $1 ORDER BY jira_worklog_id", web2.id)).toEqual([
      { issue_key: "MOB-2", jira_worklog_id: "502" },
      { issue_key: "MOB-2", jira_worklog_id: "pending-1" },
    ]);
    expect(Number((await one("SELECT count(*) AS n FROM worklogs WHERE user_id = 1 AND jira_worklog_id = '502'")).n)).toBe(1);
    expect(await one("SELECT issue_key FROM pinboard_notes WHERE item_id = $1", web2.id)).toEqual({ issue_key: "MOB-2" });
    expect(await one("SELECT issue_key FROM outbox WHERE item_id = $1", web2.id)).toEqual({ issue_key: "MOB-2" });
    expect(await q("SELECT key FROM item_aliases WHERE item_id = $1", web2.id)).toEqual([{ key: "WEB-2" }]);
    // Bob's WEB-2 is another issue: untouched.
    expect(Number((await one("SELECT count(*) AS n FROM worklogs WHERE user_id = 2 AND issue_key = 'WEB-2'")).n)).toBe(1);
    await close();
  });
});
