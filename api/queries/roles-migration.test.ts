import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readJournal } from "./migrationGuard";

/**
 * 0052_roles_teams on a server that already has people: access stays what it was.
 * Admins become owners (users.role stays "admin" for older builds), members keep their
 * JSON grants as they were, except manageBackups, which maps to runBackups only (nobody
 * gains a restore or a download), and manageServer, which keeps the audit log's retention
 * it covered (now manageRetention).
 */

const folder = path.resolve(process.cwd(), "drizzle");

/** The migrations folder as it was before 0052 (the same files, the journal cut there). */
function before0052(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-0051-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex((e) => e.tag === "0052_roles_teams");
  expect(cut).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cut);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) fs.copyFileSync(path.join(folder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

describe("0052 keeps every server's access as it was", () => {
  it("admins become owners, grants stay, manageBackups runs backups only", async () => {
    expect(readJournal(folder).some((e) => e.tag === "0052_roles_teams")).toBe(true);
    const client = new PGlite({ extensions: { pg_trgm } });
    await migrate(drizzle(client), { migrationsFolder: before0052() });
    const people: [string, string, string][] = [
      ["root", "admin", "[]"],
      ["boss", "admin", '["manageUsers"]'],
      ["plain", "member", "[]"],
      ["lead", "member", '["viewTeamTime"]'],
      ["ops", "member", '["manageBackups","manageServer"]'],
      ["mixed", "member", '["manageUsers","manageStore","manageBackups","viewTeamTime","useModules","viewAudit","exportAudit"]'],
    ];
    for (const [name, role, permissions] of people) {
      await client.query("INSERT INTO users (username, display_name, role, permissions, created_at) VALUES ($1, $1, $2, $3, 1)", [name, role, permissions]);
    }
    await migrate(drizzle(client), { migrationsFolder: folder });
    const rows = (
      await client.query<{ username: string; role: string; role_key: string | null; permissions: string }>(
        "SELECT u.username, u.role, r.key AS role_key, u.permissions FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.id",
      )
    ).rows.map((r) => ({ ...r, permissions: (JSON.parse(r.permissions) as string[]).sort() }));
    expect(rows).toEqual([
      { username: "root", role: "admin", role_key: "owner", permissions: [] },
      { username: "boss", role: "admin", role_key: "owner", permissions: ["manageUsers"] },
      { username: "plain", role: "member", role_key: null, permissions: [] },
      { username: "lead", role: "member", role_key: null, permissions: ["viewTeamTime"] },
      { username: "ops", role: "member", role_key: null, permissions: ["manageRetention", "manageServer", "runBackups"] },
      { username: "mixed", role: "member", role_key: null, permissions: ["exportAudit", "manageStore", "manageUsers", "runBackups", "useModules", "viewAudit", "viewTeamTime"] },
    ]);
    // The system roles, seeded once, read-only.
    const roles = (await client.query<{ key: string; scope: string; system: number }>("SELECT key, scope, system FROM roles ORDER BY id")).rows;
    expect(roles).toEqual([
      { key: "owner", scope: "server", system: 1 },
      { key: "it-admin", scope: "server", system: 1 },
      { key: "team-lead", scope: "team", system: 1 },
      { key: "auditor", scope: "server", system: 1 },
      { key: "member", scope: "server", system: 1 },
    ]);
    await client.close();
  });
});
