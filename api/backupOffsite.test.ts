import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// Off-site copies, end to end against an in-memory S3 (no network: the transport is
// swapped), the encryption on its own, the restore drill against a second PGlite,
// and who may do what. No real cloud call is ever made.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-offsite-backups-"));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-offsite-data-"));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-offsite-bin-"));
process.env.DATABASE_URL = ":memory:";
process.env.BACKUP_DIR = DIR;
process.env.DATA_DIR = DATA;
process.env.AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-offsite-audit-"));
// Fake pg_dump / pg_restore / psql (the real ones run in the container): a dump is a line, a restore reads it.
for (const [bin, body] of [
  ["pg_dump", `#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) echo dump > "\${a#--file=}";; esac; done\n`],
  ["pg_restore", `#!/bin/sh\necho "-- the dump's SQL"\n`],
  ["psql", `#!/bin/sh\ncat > /dev/null\n`],
]) fs.writeFileSync(path.join(BIN, bin), body, { mode: 0o755 });
process.env.PG_DUMP_BIN = path.join(BIN, "pg_dump");
process.env.PG_RESTORE_BIN = path.join(BIN, "pg_restore");
process.env.PSQL_BIN = path.join(BIN, "psql");
fs.writeFileSync(path.join(DATA, "instance.key"), "INSTANCE-KEY-BYTES");
fs.mkdirSync(path.join(DATA, "modules"));
fs.writeFileSync(path.join(DATA, "modules", "m.json"), "{}");

const KEY_A = "a".repeat(64);
const KEY_B = "correct horse battery staple";

const dumpName = (d: string) => `inkledger-${d}-020000.dump`;
const writeDump = (name: string, body: string | Buffer) => fs.writeFileSync(path.join(DIR, name), body, { mode: 0o600 });

/** A minimal S3: PUT/GET/DELETE of objects, ListObjectsV2 two keys a page; checks each request's signature headers. */
function stubS3() {
  const objects = new Map<string, { body: Buffer; at: number; headers: Record<string, string> }>();
  const calls: { method: string; key: string }[] = [];
  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (!headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=AKIDTEST/")) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const [, bucket, ...rest] = u.pathname.split("/");
    if (bucket !== "ikl-bucket") return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
    const key = decodeURIComponent(rest.join("/"));
    const method = init.method ?? "GET";
    calls.push({ method, key });
    if (method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of Readable.fromWeb(init.body as ReadableStream<Uint8Array>)) chunks.push(Buffer.from(c as Uint8Array));
      const body = Buffer.concat(chunks);
      // The payload is signed: its hash is the one in the signature, and the length the one declared.
      if (createHash("sha256").update(body).digest("hex") !== headers["x-amz-content-sha256"]) return new Response("<Error><Code>XAmzContentSHA256Mismatch</Code></Error>", { status: 400 });
      if (String(body.length) !== headers["content-length"]) return new Response("<Error><Code>IncompleteBody</Code></Error>", { status: 400 });
      objects.set(key, { body, at: Date.now(), headers });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (key === "" && u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>${new Date(objects.get(k)!.at).toISOString()}</LastModified></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    const o = objects.get(key);
    return o ? new Response(new Uint8Array(o.body), { status: 200 }) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  };
  return { objects, calls, transport };
}

const s3Settings = { kind: "s3" as const, endpoint: "https://s3.example.test", bucket: "ikl-bucket", prefix: "srv1/", region: "eu-central-1", accessKeyId: "AKIDTEST", secret: "SECRET-access-key" };

beforeAll(async () => {
  const { resetDbForTests } = await import("./queries/connection");
  await resetDbForTests();
  const { offsiteDeps } = await import("./backupOffsite");
  offsiteDeps.resolve = async () => ["203.0.113.7"];
});

afterEach(() => {
  process.env.BACKUP_KEY = KEY_A;
  delete process.env.BACKUP_KEY_OLD;
});

describe("encryption", () => {
  const roundTrip = async (plain: Buffer, enc = [KEY_A], dec = enc) => {
    const { encryptStream, decryptStream, backupKeys } = await import("./backupCrypto");
    const sealed = await collect(Readable.from([plain]).pipe(encryptStream(backupKeys({ BACKUP_KEY: enc[0] })[0])));
    const opened = await collect(Readable.from([sealed]).pipe(decryptStream(backupKeys({ BACKUP_KEY: dec[0], BACKUP_KEY_OLD: dec[1] }))));
    return { sealed, opened };
  };

  it("opens what it sealed, at every size around a record", async () => {
    const { CHUNK } = await import("./backupCrypto");
    for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17]) {
      const plain = randomBytes(n);
      const { sealed, opened } = await roundTrip(plain);
      expect(opened.equals(plain), `size ${n}`).toBe(true);
      expect(sealed.includes(plain.subarray(0, Math.min(32, n))) && n >= 32).toBe(false);
    }
  });

  it("refuses a copy altered, cut short at a record's end, or sealed with another key; BACKUP_KEY_OLD opens older ones", async () => {
    const { CHUNK, HEADER_BYTES } = await import("./backupCrypto");
    const plain = randomBytes(2 * CHUNK + 100);
    const { sealed } = await roundTrip(plain);
    const { decryptStream, backupKeys } = await import("./backupCrypto");
    const open = (b: Buffer, keys = backupKeys({ BACKUP_KEY: KEY_A })) => collect(Readable.from([b]).pipe(decryptStream(keys)));
    const flipped = Buffer.from(sealed);
    flipped[HEADER_BYTES + 10] ^= 1;
    await expect(open(flipped)).rejects.toThrow();
    // The first two records whole, the last one gone: each says whether it is the last.
    await expect(open(sealed.subarray(0, HEADER_BYTES + 2 * (CHUNK + 16)))).rejects.toThrow();
    await expect(open(sealed, backupKeys({ BACKUP_KEY: KEY_B }))).rejects.toThrow(/neither BACKUP_KEY nor BACKUP_KEY_OLD/);
    // Rotated: the new key encrypts, the old one still opens what came before.
    expect((await open(sealed, backupKeys({ BACKUP_KEY: KEY_B, BACKUP_KEY_OLD: KEY_A }))).equals(plain)).toBe(true);
  });
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe("off-site copies to S3", () => {
  it("keeps the endpoint to safe addresses, seals the secret and never shows it", async () => {
    const o = await import("./backupOffsite");
    const { getServerSetting } = await import("./lib/serverSettings");
    await expect(o.setOffsite({ ...s3Settings, endpoint: "http://169.254.169.254/latest" })).rejects.toThrow();
    const was = o.offsiteDeps.resolve;
    o.offsiteDeps.resolve = async () => ["127.0.0.1"];
    await expect(o.setOffsite(s3Settings)).rejects.toThrow();
    o.offsiteDeps.resolve = was;
    await expect(o.setOffsite({ ...s3Settings, secret: "" })).rejects.toMatchObject({ kind: "invalid" });
    const view = await o.setOffsite(s3Settings);
    expect(view).toMatchObject({ kind: "s3", hasSecret: true });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(JSON.stringify(await getServerSetting("backup.offsite", null))).not.toContain("SECRET-access-key");
    // Left out, the saved secret stays.
    expect(await o.setOffsite({ prefix: "srv1/" })).toMatchObject({ hasSecret: true });
    // And the guarded transport checks again before each call.
    const { guardedTransport } = await import("./backupS3");
    await expect(guardedTransport("http://127.0.0.1:9000")("http://127.0.0.1:9000/b/k", { method: "GET" })).rejects.toThrow();
  });

  it("uploads each backup encrypted with its data folder, thins old copies, and brings one back intact", async () => {
    const o = await import("./backupOffsite");
    const s3 = stubS3();
    o.offsiteDeps.transport = s3.transport;
    process.env.BACKUP_KEY = KEY_A;
    await o.setOffsite({ ...s3Settings, keepDaily: 2, keepWeekly: 0, keepMonthly: 0 });
    const days = ["20261101", "20261102", "20261103"];
    const bodies = new Map<string, Buffer>();
    for (const d of days) {
      const name = dumpName(d);
      bodies.set(name, randomBytes(70_000));
      writeDump(name, bodies.get(name)!);
      const state = await o.uploadOffsite(name);
      expect(state?.lastName, state?.lastError ?? "").toBe(name);
    }
    // The newest two days stay (dump and data archive each); the oldest pair is gone.
    expect([...s3.objects.keys()].sort()).toEqual([
      "srv1/inkledger-20261102-020000.data.tar.gz.enc",
      "srv1/inkledger-20261102-020000.dump.enc",
      "srv1/inkledger-20261103-020000.data.tar.gz.enc",
      "srv1/inkledger-20261103-020000.dump.enc",
    ]);
    const stored = s3.objects.get("srv1/inkledger-20261103-020000.dump.enc")!;
    expect(stored.body.subarray(0, 4).toString()).toBe("IKLB");
    expect(stored.body.includes(bodies.get(dumpName("20261103"))!.subarray(0, 64))).toBe(false);
    expect(stored.headers["x-amz-checksum-sha256"]).toBe(createHash("sha256").update(stored.body).digest("base64"));
    expect((await o.listOffsite()).map((c) => c.name)).toEqual([dumpName("20261103"), dumpName("20261102")]);

    // Gone from this server: fetched back, decrypted, the same bytes; the data archive beside it.
    const name = dumpName("20261102");
    fs.rmSync(path.join(DIR, name));
    const got = await o.fetchOffsite(name);
    expect(fs.readFileSync(path.join(DIR, name)).equals(bodies.get(name)!)).toBe(true);
    expect(fs.statSync(path.join(DIR, name)).mode & 0o777).toBe(0o600);
    expect(got.data).toBe("inkledger-20261102-020000.data.tar.gz");
    const listed = execFileSync("tar", ["-tzf", path.join(DIR, got.data!)], { encoding: "utf8" });
    expect(listed).toContain("instance.key");
    expect(listed).toContain("modules/m.json");
    await expect(o.fetchOffsite("../../etc/passwd")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("Object Lock asks for retention on each copy", async () => {
    const o = await import("./backupOffsite");
    const s3 = stubS3();
    o.offsiteDeps.transport = s3.transport;
    await o.setOffsite({ ...s3Settings, objectLockDays: 30, objectLockMode: "COMPLIANCE" });
    const name = dumpName("20261110");
    writeDump(name, "dump");
    await o.uploadOffsite(name);
    const put = s3.objects.get(`srv1/${name}.enc`)!;
    expect(put.headers["x-amz-object-lock-mode"]).toBe("COMPLIANCE");
    expect(Date.parse(put.headers["x-amz-object-lock-retain-until-date"]) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(put.headers["content-md5"]).toBeTruthy();
    await o.setOffsite({ objectLockDays: 0 });
  });

  it("without BACKUP_KEY nothing leaves: the failure is recorded and alerted, then cleared by the next copy", async () => {
    const o = await import("./backupOffsite");
    const { getServerSetting } = await import("./lib/serverSettings");
    const s3 = stubS3();
    o.offsiteDeps.transport = s3.transport;
    await o.setOffsite(s3Settings);
    delete process.env.BACKUP_KEY;
    const name = dumpName("20261111");
    writeDump(name, "dump");
    const state = await o.uploadOffsite(name);
    expect(state?.lastError).toMatch(/BACKUP_KEY/);
    expect(s3.calls).toEqual([]);
    const alerts = await getServerSetting<{ firing: Record<string, { kind: string }> }>("alerts.state", { firing: {} });
    expect(alerts.firing.offsite?.kind).toBe("offsite");
    process.env.BACKUP_KEY = KEY_A;
    expect((await o.uploadOffsite(name))?.lastName).toBe(name);
    expect((await getServerSetting<{ firing: Record<string, unknown> }>("alerts.state", { firing: {} })).firing.offsite).toBeUndefined();
  });

  it("keeps the newest of each day, week and month", async () => {
    const { toKeep } = await import("./backupOffsite");
    const names = ["20261001", "20261015", "20261101", "20261108", "20261109", "20261110"].flatMap((d) => [`inkledger-${d}-010000.dump`, `inkledger-${d}-020000.dump`]);
    const kept = [...toKeep(names, { keepDaily: 2, keepWeekly: 2, keepMonthly: 2 })].sort();
    expect(kept).toEqual([
      "inkledger-20261015-020000.dump",
      "inkledger-20261108-020000.dump",
      "inkledger-20261109-020000.dump",
      "inkledger-20261110-020000.dump",
    ]);
  });
});

describe("off-site copies with restic", () => {
  it("backs up through the restic binary with the password from the environment, never on its command line", async () => {
    const log = path.join(BIN, "restic.log");
    const restic = path.join(BIN, "restic");
    fs.writeFileSync(
      restic,
      `#!/bin/sh\necho "$@ | pw=$RESTIC_PASSWORD" >> "${log}"\ncase "$1" in snapshots) echo '[{"id":"abc123","time":"2026-11-12T02:00:00Z","tags":["inkledger","inkledger-20261112-020000"],"paths":["/stage"]}]';; dump) echo restored-dump;; esac\n`,
      { mode: 0o755 },
    );
    process.env.RESTIC_BIN = restic;
    process.env.RESTIC_REPOSITORY = "s3:https://restic.example.test/repo";
    process.env.RESTIC_PASSWORD = "SECRET-restic-pw";
    try {
      const o = await import("./backupOffsite");
      await o.setOffsite({ kind: "restic", keepDaily: 3, keepWeekly: 1, keepMonthly: 1 });
      const name = dumpName("20261112");
      writeDump(name, "dump");
      expect((await o.uploadOffsite(name))?.lastName).toBe(name);
      const lines = fs.readFileSync(log, "utf8").trim().split("\n");
      expect(lines[0]).toMatch(/^backup --host inkledger --tag inkledger --tag inkledger-20261112-020000 .*\.restic-stage \| pw=SECRET-restic-pw$/);
      expect(lines[1]).toContain("forget --host inkledger --tag inkledger --group-by host,paths --keep-last 1 --keep-daily 3 --keep-weekly 1 --keep-monthly 1 --prune");
      expect(lines.every((l) => !l.split(" | ")[0].includes("SECRET"))).toBe(true);
      expect(await o.listOffsite()).toMatchObject([{ name }]);
      fs.rmSync(path.join(DIR, name));
      await o.fetchOffsite(name);
      expect(fs.readFileSync(path.join(DIR, name), "utf8").trim()).toBe("restored-dump");
      expect(fs.readFileSync(log, "utf8")).toContain(`dump abc123 /stage/${name}`);
    } finally {
      delete process.env.RESTIC_BIN;
      delete process.env.RESTIC_REPOSITORY;
      delete process.env.RESTIC_PASSWORD;
      const o = await import("./backupOffsite");
      await o.setOffsite({ kind: "none" });
    }
  });
});

describe("restore drill", () => {
  /** The drill on a second PGlite: a "dump" here is the live database's data folder, loaded whole. */
  const pgliteTarget = async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { drizzle } = await import("drizzle-orm/pglite");
    let scratch: InstanceType<typeof PGlite> | null = null;
    const steps: string[] = [];
    return {
      steps,
      target: {
        prepare: async () => void steps.push("prepare"),
        restore: async (file: string) => {
          steps.push(`restore ${path.basename(file)}`);
          scratch = new PGlite({ loadDataDir: new Blob([fs.readFileSync(file)]), extensions: { pg_trgm } });
          await scratch.waitReady;
        },
        open: async () => {
          const db = scratch!;
          return { db: drizzle(db) as unknown as import("./queries/connection").Db, query: (t: string) => db.query<Record<string, unknown>>(t), close: async () => undefined };
        },
        drop: async () => {
          steps.push("drop");
          await scratch?.close();
          scratch = null;
        },
      },
    };
  };
  const liveDump = async () => {
    const { getDb } = await import("./queries/connection");
    const client = (getDb() as unknown as { $client: { dumpDataDir: (c: "none") => Promise<Blob> } }).$client;
    return Buffer.from(await (await client.dumpDataDir("none")).arrayBuffer());
  };

  it("never targets the live database", async () => {
    const { drillUrl } = await import("./backupDrill");
    expect(drillUrl("postgres://u:p@db:5432/inkledger")).toBe("postgres://u:p@db:5432/inkledger_drill");
    expect(() => drillUrl("postgres://u:p@db:5432/inkledger_drill")).toThrow(/live database/);
  });

  it("restores the newest backup into scratch, counts it, checks its migrations and sealed values, then drops it", async () => {
    const { q, newestMigration } = await import("./queries/connection");
    const { runDrill, getLastDrill } = await import("./backupDrill");
    await q("INSERT INTO users (username, display_name, role, created_at) VALUES ('drill-a', 'A', 'admin', 1)");
    for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
    writeDump(dumpName("20261120"), "older");
    writeDump(dumpName("20261121"), await liveDump());
    const usersBefore = (await q<{ n: number }>("SELECT count(*)::int AS n FROM users"))[0].n;
    const { target, steps } = await pgliteTarget();
    const r = await runDrill({ target });
    expect(r, r.error ?? "").toMatchObject({ ok: true, dump: dumpName("20261121"), users: usersBefore, migrationHead: newestMigration(), sealedUnreadable: 0 });
    expect(steps).toEqual(["prepare", `restore ${dumpName("20261121")}`, "drop"]);
    expect(await getLastDrill()).toMatchObject({ ok: true, dump: dumpName("20261121") });
    // The live database as it was.
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM users"))[0].n).toBe(usersBefore);
  });

  it("a failed drill is recorded and alerted, and the scratch database still goes", async () => {
    const { q } = await import("./queries/connection");
    const { getServerSetting } = await import("./lib/serverSettings");
    const { runDrill } = await import("./backupDrill");
    // A sealed value no configured key opens: the backup restores, its secrets wouldn't.
    await q("INSERT INTO server_settings (key, value, updated_at) VALUES ('alerts.webhook', ?, 1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify({ url: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA", secret: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA", format: "json" }));
    writeDump(dumpName("20261122"), await liveDump());
    await q("DELETE FROM server_settings WHERE key = 'alerts.webhook'");
    const { target, steps } = await pgliteTarget();
    const r = await runDrill({ target });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sealed value/);
    expect(steps.at(-1)).toBe("drop");
    const alerts = await getServerSetting<{ firing: Record<string, { kind: string; name: string }> }>("alerts.state", { firing: {} });
    expect(alerts.firing.drill).toMatchObject({ kind: "drill", name: dumpName("20261122") });
    // A dump that doesn't restore at all: failed too.
    writeDump(dumpName("20261123"), "not a dump");
    const broken = await runDrill({ target: (await pgliteTarget()).target });
    expect(broken.ok).toBe(false);
  });

  it("runs weekly when due, and writes its own audit event then", async () => {
    const { q } = await import("./queries/connection");
    const { flushAudit } = await import("./lib/audit");
    const { drillIfDue, getLastDrill, DRILL_EVERY_MS } = await import("./backupDrill");
    const last = (await getLastDrill())!;
    expect(await drillIfDue(last.at + 1000, (await pgliteTarget()).target)).toBeNull();
    for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
    writeDump(dumpName("20261124"), await liveDump());
    const r = await drillIfDue(last.at + DRILL_EVERY_MS + 1, (await pgliteTarget()).target);
    expect(r?.ok).toBe(true);
    await flushAudit();
    const [ev] = await q<{ action: string; actor_kind: string; outcome: string }>("SELECT action, actor_kind, outcome FROM audit_events WHERE action = 'backup.drill' ORDER BY id DESC LIMIT 1");
    expect(ev).toMatchObject({ action: "backup.drill", actor_kind: "system", outcome: "ok" });
  });
});

describe("after each backup", () => {
  it("the new dump goes off-site on its own; the safety copy a restore takes first does not", async () => {
    for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
    const o = await import("./backupOffsite");
    const b = await import("./backup");
    const s3 = stubS3();
    o.offsiteDeps.transport = s3.transport;
    await o.setOffsite({ ...s3Settings, keepDaily: 30 });
    const name = await b.runBackup();
    await expect.poll(async () => (await o.getOffsiteState()).lastName, { timeout: 10_000 }).toBe(name);
    expect(s3.objects.has(`srv1/${name}.enc`)).toBe(true);
    await new Promise((r) => setTimeout(r, 1100)); // a new second: a new safety file name
    const { safety } = await b.restoreBackup(name);
    expect(safety).not.toBe(name);
    // Anything queued before this has run once it resolves.
    await o.queueOffsite(name);
    expect(s3.objects.has(`srv1/${safety}.enc`)).toBe(false);
    await o.setOffsite({ kind: "none" });
  }, 30_000);
});

describe("who may do what", () => {
  const caller = async (role: "admin" | "member", permissions: string[]) => {
    const { appRouter } = await import("./router");
    const { getDb, q } = await import("./queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [{ id }] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, permissions, created_at) VALUES (?, 'X', ?, ?, 1) RETURNING id", `who${Math.random()}`, role, JSON.stringify(permissions));
    const [user] = await getDb().select().from(users).where(eq(users.id, id));
    return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: `dev-${id}` });
  };

  it("restoring from off-site takes restoreBackups and being an owner; the rest takes runBackups", async () => {
    const name = dumpName("20261124");
    const plain = await caller("member", []);
    await expect(plain.backup.offsiteRestore({ name })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(plain.backup.drill()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(plain.backup.offsiteUpdate({ kind: "none" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // restoreBackups without being an owner: still no (the backup's accounts come back with it).
    const restorer = await caller("member", ["restoreBackups", "runBackups"]);
    await expect(restorer.backup.offsiteRestore({ name })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // runBackups: settings and status, never the secret.
    const view = await restorer.backup.get();
    expect(view.canRestore).toBe(false);
    expect(JSON.stringify(view.offsite)).not.toContain("SECRET");
    expect(view).toHaveProperty("drill");
  });
});
