import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";

process.env.DATABASE_URL = ":memory:";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-backup-download-"));
process.env.BACKUP_DIR = DIR;

/**
 * GET /api/backups/:name: a dump leaves the server only for downloadBackups. Running
 * backups doesn't give it, nor does the IT admin role (it runs them, never takes everyone's
 * data away). Every download is an audit event.
 */

const NAME = "inkledger-20260101-000000.dump";
const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => (await import("./queries/connection")).q<T>(text, ...params);

let app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> };
let n = 0;

/** A signed-in account's cookie: an owner, a role's holder, or a member with these grants. */
async function signedIn(o: { owner?: boolean; role?: string; permissions?: string[] }): Promise<string> {
  const [role] = o.role ? await q<{ id: number }>("SELECT id FROM roles WHERE key = ?", o.role) : [];
  const [{ id }] = await q<{ id: number }>(
    "INSERT INTO users (username, display_name, role, role_id, permissions, created_at) VALUES (?, 'Someone', ?, ?, ?, 1) RETURNING id",
    `dl${++n}`,
    o.owner ? "admin" : "member",
    role?.id ?? null,
    JSON.stringify(o.permissions ?? []),
  );
  const token = randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", createHash("sha256").update(token).digest("hex"), id, Date.now() + 3_600_000, Date.now());
  const { sessionCookie } = await import("./lib/session");
  return sessionCookie(new Request("http://localhost/"), token, 3600).split(";")[0];
}

const get = (cookie: string, name = NAME) => app.request(`http://localhost/api/backups/${encodeURIComponent(name)}`, { headers: { cookie } });

beforeAll(async () => {
  await (await import("./queries/connection")).resetDbForTests();
  fs.writeFileSync(path.join(DIR, NAME), "PGDMP-everyone");
  const { Hono } = await import("hono");
  const { registerBackupRoutes } = await import("./backupDownload");
  const hono = new Hono<{ Bindings: HttpBindings }>();
  registerBackupRoutes(hono);
  app = hono;
});

describe("downloading a backup", () => {
  it("takes downloadBackups: an owner gets the dump, and it is recorded", async () => {
    const res = await get(await signedIn({ owner: true }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PGDMP-everyone");
    expect(res.headers.get("content-disposition")).toContain(NAME);
    const { flushAudit } = await import("./lib/audit");
    await flushAudit();
    expect(await q("SELECT action, outcome, target_id FROM audit_events WHERE action = 'backup.download'")).toEqual([{ action: "backup.download", outcome: "ok", target_id: NAME }]);
  });

  it("is refused to an IT admin, and to whoever only runs backups", async () => {
    expect((await get(await signedIn({ role: "it-admin" }))).status).toBe(403);
    expect((await get(await signedIn({ permissions: ["runBackups"] }))).status).toBe(403);
    expect((await get("nope=1")).status).toBe(401);
  });

  it("serves only a backup the folder lists, by its exact name", async () => {
    const cookie = await signedIn({ permissions: ["downloadBackups"] });
    expect((await get(cookie)).status).toBe(200);
    expect((await get(cookie, "../.env")).status).toBe(404);
    expect((await get(cookie, "inkledger-20990101-000000.dump")).status).toBe(404);
  });
});
