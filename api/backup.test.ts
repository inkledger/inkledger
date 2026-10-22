import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-backups-"));
// Fake pg_dump / pg_restore: write the --file / record the call (the real
// ones run in the container, against Postgres).
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-bin-"));
fs.writeFileSync(
  path.join(BIN, "pg_dump"),
  `#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) echo dump > "\${a#--file=}";; esac; done\n`,
  { mode: 0o755 },
);
// Like the real one: a missing file fails. Also records the password env, and
// writes the dump as SQL on stdout (FAKE_RESTORE_FAIL: dies halfway through).
fs.writeFileSync(
  path.join(BIN, "pg_restore"),
  `#!/bin/sh\nfor a in "$@"; do f="$a"; done\n[ -f "$f" ] || { echo "no file $f" >&2; exit 1; }\necho "$@ pw=$PGPASSWORD" > "${DIR}/restored.txt"\necho "-- the dump's SQL"\n[ -n "$FAKE_RESTORE_FAIL" ] && { echo "broken archive" >&2; exit 1; }\necho "-- end of dump"\n`,
  { mode: 0o755 },
);
// psql: records its pid, its arguments and what it was fed; "committed" only once its input ended.
fs.writeFileSync(
  path.join(BIN, "psql"),
  `#!/bin/sh\necho $$ > "${DIR}/psql.pid"\necho "$@ pw=$PGPASSWORD" > "${DIR}/psql-args.txt"\ncat > "${DIR}/psql-input.sql"\necho committed >> "${DIR}/psql-input.sql"\n`,
  { mode: 0o755 },
);
process.env.DATABASE_URL = ":memory:";
process.env.BACKUP_DIR = DIR;
process.env.PG_DUMP_BIN = path.join(BIN, "pg_dump");
process.env.PG_RESTORE_BIN = path.join(BIN, "pg_restore");
process.env.PSQL_BIN = path.join(BIN, "psql");

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("backup schedule", () => {
  it("computes the next run", async () => {
    const { nextRun, DEFAULT_BACKUP: base } = await import("./backup");
    const now = at(2026, 10, 16, 17, 30); // a Friday
    expect(nextRun({ ...base, schedule: "off" }, now)).toBeNull();
    expect(nextRun({ ...base, schedule: "hourly" }, now)).toEqual(at(2026, 10, 16, 18));
    expect(nextRun({ ...base, schedule: "daily", time: "18:00" }, now)).toEqual(at(2026, 10, 16, 18));
    expect(nextRun({ ...base, schedule: "daily", time: "02:00" }, now)).toEqual(at(2026, 10, 17, 2));
    expect(nextRun({ ...base, schedule: "weekly", time: "02:00", weekday: 1 }, now)).toEqual(at(2026, 10, 19, 2));
    expect(nextRun({ ...base, schedule: "weekly", time: "18:00", weekday: 5 }, now)).toEqual(at(2026, 10, 16, 18));
    expect(nextRun({ ...base, schedule: "weekly", time: "09:00", weekday: 5 }, now)).toEqual(at(2026, 10, 23, 9));
    expect(nextRun({ ...base, schedule: "weekly", time: "09:00", weekday: 7 }, now)).toEqual(at(2026, 10, 18, 9));
  });

  it("names files by local time and keeps the newest N", async () => {
    const { backupName, toPrune } = await import("./backup");
    expect(backupName(at(2026, 1, 2, 3, 4))).toBe("inkledger-20260102-030400.dump");
    const files = ["inkledger-20260101-020000.dump", "inkledger-20260103-020000.dump", "inkledger-20260102-020000.dump", "notes.txt"];
    expect(toPrune(files, 2)).toEqual(["inkledger-20260101-020000.dump"]);
    expect(toPrune(files, 5)).toEqual([]);
    expect(toPrune(files, 2, "inkledger-20260101-020000.dump")).toEqual([]);
  });
});

describe("backups on disk", () => {
  beforeAll(async () => {
    const conn = await import("./queries/connection");
    await conn.resetDbForTests();
  });

  it("«Backup ora» writes a dump, prunes beyond `keep`, records the outcome", async () => {
    const b = await import("./backup");
    await b.setBackupSettings({ keep: 2 });
    for (const old of ["inkledger-20200101-000000.dump", "inkledger-20200102-000000.dump"]) fs.writeFileSync(path.join(DIR, old), "x");
    const name = await b.runBackup();
    expect(fs.readFileSync(path.join(DIR, name), "utf8").trim()).toBe("dump");
    expect(b.listBackups().map((f) => f.name)).toEqual([name, "inkledger-20200102-000000.dump"]);
    expect((await b.getBackupState()).lastOkAt).toBeTypeOf("number");
    // No half-written file is ever listed.
    expect(fs.readdirSync(DIR).some((f) => f.endsWith(".partial"))).toBe(false);
  });

  it("restoring makes a safety backup first, and refuses unknown files", async () => {
    const b = await import("./backup");
    const [newest] = b.listBackups();
    await new Promise((r) => setTimeout(r, 1100)); // a new second → a new file name
    const { safety } = await b.restoreBackup("inkledger-20200102-000000.dump");
    expect(safety).not.toBe(newest.name);
    // The dump goes in whole, in one transaction, over an emptied database: a backup from
    // before a migration that added a table must not trip over that table (it can't be
    // dropped by --clean, which only knows what the backup holds).
    const restored = fs.readFileSync(path.join(DIR, "restored.txt"), "utf8");
    expect(restored).toMatch(/--file=- .*inkledger-20200102-000000\.dump/);
    expect(restored).not.toContain("--clean");
    const psqlArgs = fs.readFileSync(path.join(DIR, "psql-args.txt"), "utf8");
    expect(psqlArgs).toContain("--single-transaction");
    expect(psqlArgs).toContain("ON_ERROR_STOP=1");
    const fed = fs.readFileSync(path.join(DIR, "psql-input.sql"), "utf8");
    // Quiet: a failure's message starts with its cause, not one "drop cascades to" notice per table.
    expect(fed.startsWith("SET client_min_messages = warning;")).toBe(true);
    expect(fed.indexOf("DROP SCHEMA public CASCADE")).toBeGreaterThanOrEqual(0);
    expect(fed.indexOf("DROP SCHEMA public CASCADE")).toBeLessThan(fed.indexOf("-- the dump's SQL"));
    // Before it commits: a backup from a newer build (migrations this one doesn't know) is refused.
    // In the same transaction: no session the backup held is ever valid.
    expect(fed).toMatch(/-- end of dump\nDELETE FROM public\.remembered_devices;\nDELETE FROM public\.sessions;\nDO \$\$ BEGIN IF EXISTS \(SELECT 1 FROM drizzle\.__drizzle_migrations WHERE created_at > \d+\)[^\n]*\ncommitted/);
    // The oldest of `keep` files: the safety backup must not prune it away.
    expect(fs.existsSync(path.join(DIR, "inkledger-20200102-000000.dump"))).toBe(true);
    await expect(b.restoreBackup("../etc/passwd")).rejects.toThrow(/Invalid backup/);
  });

  it("a dump that breaks halfway is never committed: psql is stopped before its input ends", async () => {
    const b = await import("./backup");
    fs.writeFileSync(path.join(DIR, "inkledger-20200102-000000.dump"), "x");
    for (const f of ["psql-input.sql", "psql.pid"]) fs.rmSync(path.join(DIR, f), { force: true });
    process.env.FAKE_RESTORE_FAIL = "1";
    try {
      await expect(b.restoreBackup("inkledger-20200102-000000.dump")).rejects.toThrow(/broken archive/);
    } finally {
      delete process.env.FAKE_RESTORE_FAIL;
    }
    // Stopped, never left waiting on its input (a real one would hold the transaction and its locks).
    const alive = () => {
      if (!fs.existsSync(path.join(DIR, "psql.pid"))) return false; // stopped before it even began
      // Stopped while writing its pid: no pid (and 0 would ask about the whole process group).
      const pid = Number(fs.readFileSync(path.join(DIR, "psql.pid"), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive).toBe(false);
    const fed = fs.existsSync(path.join(DIR, "psql-input.sql")) ? fs.readFileSync(path.join(DIR, "psql-input.sql"), "utf8") : "";
    expect(fed).not.toContain("committed");
  });

  it("after a restore everyone is signed out but whoever restored (no session the backup held comes back)", async () => {
    const b = await import("./backup");
    const { q } = await import("./queries/connection");
    const [me] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('restorer', 'R', 'admin', 1) RETURNING id");
    const [other] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('other', 'O', 1) RETURNING id");
    const later = Date.now() + 86_400_000;
    await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('mine', ?, ?, 1), ('revoked-but-back', ?, ?, 1)", me.id, later, other.id, later);
    await q("INSERT INTO remembered_devices (id, user_id, expires_at, last_used_at, created_at) VALUES ('dev', ?, ?, 1, 1)", other.id, later);
    fs.writeFileSync(path.join(DIR, "inkledger-20200102-000000.dump"), "x");
    await b.restoreBackup("inkledger-20200102-000000.dump", { keepSession: { id: "mine", userId: me.id, username: "restorer" } });
    expect(await q("SELECT id, user_id FROM sessions")).toEqual([{ id: "mine", user_id: me.id }]);
    expect(await q("SELECT id FROM remembered_devices")).toEqual([]);
    // In the backup, that id is someone else's: the session isn't handed to them.
    await b.restoreBackup("inkledger-20200102-000000.dump", { keepSession: { id: "mine", userId: other.id, username: "restorer" } });
    expect(await q("SELECT id FROM sessions")).toEqual([]);
  });

  it("what went wrong reaches the admin as such (the production server hides internal errors' words)", async () => {
    const { q } = await import("./queries/connection");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('backup-admin', 'B', 'admin', 1) RETURNING id");
    const { appRouter } = await import("./router");
    const { getDb } = await import("./queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    const admin = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    await expect(admin.backup.restore({ name: "../etc/passwd" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.backup.restore({ name: "inkledger-19990101-000000.dump" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fs.writeFileSync(path.join(DIR, "inkledger-20200102-000000.dump"), "x");
    process.env.FAKE_RESTORE_FAIL = "1";
    try {
      // The cause, and the safety backup that undoes whatever happened.
      await expect(admin.backup.restore({ name: "inkledger-20200102-000000.dump" })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: expect.stringMatching(/broken archive[\s\S]*inkledger-\d{8}-\d{6}\.dump/),
      });
    } finally {
      delete process.env.FAKE_RESTORE_FAIL;
    }
  });

  it("a folder that can't be written is an error, not a crash", async () => {
    const b = await import("./backup");
    process.env.BACKUP_DIR = path.join(DIR, "missing");
    await expect(b.runBackup()).rejects.toThrow(/not writable/);
    expect((await b.getBackupState()).lastError).toMatch(/not writable/);
    process.env.BACKUP_DIR = DIR;
  });
});
