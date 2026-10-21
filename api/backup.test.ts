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
    expect(fed).toMatch(/-- end of dump\ncommitted/);
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
      try {
        process.kill(Number(fs.readFileSync(path.join(DIR, "psql.pid"), "utf8")), 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive).toBe(false);
    const fed = fs.existsSync(path.join(DIR, "psql-input.sql")) ? fs.readFileSync(path.join(DIR, "psql-input.sql"), "utf8") : "";
    expect(fed).not.toContain("committed");
  });

  it("a folder that can't be written is an error, not a crash", async () => {
    const b = await import("./backup");
    process.env.BACKUP_DIR = path.join(DIR, "missing");
    await expect(b.runBackup()).rejects.toThrow(/not writable/);
    expect((await b.getBackupState()).lastError).toMatch(/not writable/);
    process.env.BACKUP_DIR = DIR;
  });
});
