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
// Like the real one: a missing file fails. Also records the password env.
fs.writeFileSync(
  path.join(BIN, "pg_restore"),
  `#!/bin/sh\nfor a in "$@"; do f="$a"; done\n[ -f "$f" ] || { echo "no file $f" >&2; exit 1; }\necho "$@ pw=$PGPASSWORD" > "${DIR}/restored.txt"\n`,
  { mode: 0o755 },
);
process.env.DATABASE_URL = ":memory:";
process.env.BACKUP_DIR = DIR;
process.env.PG_DUMP_BIN = path.join(BIN, "pg_dump");
process.env.PG_RESTORE_BIN = path.join(BIN, "pg_restore");

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
    expect(fs.readFileSync(path.join(DIR, "restored.txt"), "utf8")).toMatch(/--clean .*inkledger-20200102-000000\.dump/);
    // The oldest of `keep` files: the safety backup must not prune it away.
    expect(fs.existsSync(path.join(DIR, "inkledger-20200102-000000.dump"))).toBe(true);
    await expect(b.restoreBackup("../etc/passwd")).rejects.toThrow(/Invalid backup/);
  });

  it("a folder that can't be written is an error, not a crash", async () => {
    const b = await import("./backup");
    process.env.BACKUP_DIR = path.join(DIR, "missing");
    await expect(b.runBackup()).rejects.toThrow(/not writable/);
    expect((await b.getBackupState()).lastError).toMatch(/not writable/);
    process.env.BACKUP_DIR = DIR;
  });
});
