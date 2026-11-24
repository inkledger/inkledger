import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = ":memory:";
const AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-audit-"));
process.env.AUDIT_DIR = AUDIT_DIR;
process.env.AUDIT_FILE_MIRROR = "1";

type Row = Record<string, unknown>;
const q = async <T = Row>(text: string, ...params: unknown[]): Promise<T[]> => (await import("../queries/connection")).q<T>(text, ...params);

const system = { kind: "system", label: "test" } as const;

beforeAll(async () => {
  const { resetDbForTests } = await import("../queries/connection");
  await resetDbForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The rows the trigger lets go: only under the purge's own setting, in its transaction. */
async function purgeAll() {
  const { getDb } = await import("../queries/connection");
  const { sql } = await import("drizzle-orm");
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('inkledger.audit_purge', 'on', true)`);
    await tx.execute(sql`DELETE FROM audit_events`);
  });
}

describe("the audit log is append-only", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    const { recordSystem } = await import("./audit");
    const e = await recordSystem(system, "backup.run", { after: { name: "x.dump" } });
    expect(e).not.toBeNull();
    await expect(q("UPDATE audit_events SET action = 'auth.signIn' WHERE id = ?", e!.id)).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM audit_events WHERE id = ?", e!.id)).rejects.toThrow(/append-only/);
    await expect(q("TRUNCATE audit_events")).rejects.toThrow(/append-only/);
    // Not even with the purge's setting outside a transaction of its own (it is local to one).
    await q("SELECT set_config('inkledger.audit_purge', 'on', true)");
    await expect(q("DELETE FROM audit_events WHERE id = ?", e!.id)).rejects.toThrow(/append-only/);
    // An UPDATE is refused even under the purge's setting: purging only deletes.
    const { getDb } = await import("../queries/connection");
    const { sql } = await import("drizzle-orm");
    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('inkledger.audit_purge', 'on', true)`);
        await tx.execute(sql`UPDATE audit_events SET action = 'x'`);
      }),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
    expect(await q("SELECT action FROM audit_events WHERE id = ?", e!.id)).toEqual([{ action: "backup.run" }]);
  });
});

describe("retention", () => {
  it("purges only what is older than the retention, never under the minimum", async () => {
    const { recordSystem, purgeAudit, flushAudit, verifyAudit } = await import("./audit");
    const { setServerSetting } = await import("./serverSettings");
    await purgeAll();
    const day = 86_400_000;
    const now = Date.UTC(2026, 10, 24, 12);
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const ago of [200, 120, 91, 89, 10]) {
      vi.setSystemTime(now - ago * day);
      await recordSystem(system, "backup.run", { after: { name: `${ago}.dump` } });
    }
    vi.setSystemTime(now);
    await flushAudit();
    // 30 is under the minimum: 90 days are kept whatever is stored.
    await setServerSetting("audit.retentionDays", 30);
    expect(await purgeAudit(now)).toBe(3);
    const left = await q<{ action: string; after: string }>("SELECT action, after FROM audit_events ORDER BY id");
    expect(left.map((r) => r.after)).toEqual([JSON.stringify({ name: "89.dump" }), JSON.stringify({ name: "10.dump" }), expect.stringContaining('"deleted":3')]);
    expect(left.at(-1)?.action).toBe("audit.purge");
    // The chain still checks: the oldest row left anchors it.
    expect(await verifyAudit()).toMatchObject({ ok: true, anchored: true, checked: 3 });
    // Nothing older than 400 days by default.
    await setServerSetting("audit.retentionDays", null);
    expect(await purgeAudit(now)).toBe(0);
  });
});

describe("the hash chain", () => {
  it("verify passes an untouched chain and finds an edited or removed row", async () => {
    const { recordSystem, verifyAudit, flushAudit } = await import("./audit");
    await purgeAll();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await recordSystem(system, "backup.run", { after: { name: `${i}.dump` } }))!.id);
    await flushAudit();
    expect(await verifyAudit(2)).toEqual({ ok: true, checked: 5, anchored: false });
    // Whoever owns the table can switch the trigger off: the chain still tells.
    await q("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    try {
      await q("UPDATE audit_events SET after = ? WHERE id = ?", JSON.stringify({ name: "forged.dump" }), ids[2]);
      expect(await verifyAudit(2)).toEqual({ ok: false, checked: 2, badId: ids[2], reason: "hash" });
      await q("DELETE FROM audit_events WHERE id = ?", ids[2]);
      expect(await verifyAudit(2)).toEqual({ ok: false, checked: 2, badId: ids[3], reason: "link" });
    } finally {
      await q("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    }
  });

  it("events written at once chain one after the other", async () => {
    const { recordSystem, verifyAudit } = await import("./audit");
    await purgeAll();
    await Promise.all(Array.from({ length: 12 }, (_, i) => recordSystem(system, "backup.run", { after: { name: `${i}` } })));
    expect(await verifyAudit()).toMatchObject({ ok: true, checked: 12 });
  });
});

describe("redaction", () => {
  /** What must never reach a row: secrets, tokens, password hashes, licence text, invite links. */
  const POISON: Record<string, string> = {
    password: "SECRET-password",
    passwordHash: "SECRET-hash",
    newPassword: "SECRET-new",
    current: "SECRET-current",
    next: "SECRET-next",
    token: "SECRET-token",
    accessToken: "SECRET-access",
    refreshToken: "SECRET-refresh",
    encryptedSecret: "SECRET-sealed",
    webhookSecret: "SECRET-webhook",
    secret: "SECRET-secret",
    code: "SECRET-code",
    text: "SECRET-licence",
    link: "SECRET-/invite/abc",
    email: "SECRET@example.com",
    comment: "SECRET-comment",
    message: "SECRET-message",
  };
  const SECRETISH = /password|secret|token|cookie|session|apikey|credential/i;

  it("no action keeps a field that holds a secret", async () => {
    const { AUDIT_ACTIONS } = await import("@contracts/audit");
    for (const [action, fields] of Object.entries(AUDIT_ACTIONS)) {
      for (const f of fields as readonly string[]) expect.soft(f, action).not.toMatch(SECRETISH);
      for (const f of Object.keys(POISON)) expect.soft(fields as readonly string[], action).not.toContain(f);
    }
  });

  it("every action, fed its own fields and every secret: only its own come through (snapshot)", async () => {
    const { AUDIT_ACTIONS } = await import("@contracts/audit");
    const { redact } = await import("./audit");
    const out: Record<string, unknown> = {};
    for (const [action, fields] of Object.entries(AUDIT_ACTIONS)) {
      const own = Object.fromEntries((fields as readonly string[]).map((f) => [f, `v:${f}`]));
      const kept = redact(action, { ...POISON, ...own });
      expect.soft(JSON.stringify(kept), action).not.toContain("SECRET");
      // Compact: what came through as given, and how many fields were redacted.
      const entries = Object.entries(kept ?? {});
      out[action] = { kept: entries.filter(([, v]) => v !== "[redacted]").map(([k]) => k).sort(), redacted: entries.filter(([, v]) => v === "[redacted]").length };
    }
    // An action nobody registered keeps nothing.
    expect(JSON.stringify(redact("no.such", POISON))).not.toContain("SECRET");
    expect(out).toMatchSnapshot();
  });

  it("an event written through record() holds no secret, in the row or the file", async () => {
    const { record, auditFile, flushAudit } = await import("./audit");
    const req = new Request("http://localhost/", { headers: { "user-agent": "UA-test" } });
    const e = await record({ req, user: { id: 7, username: "ann", displayName: "Ann" } }, "users.resetPassword", { target: { type: "user", id: 9 }, after: { username: "bob", password: "SECRET-temp", passwordHash: "SECRET-h" } });
    await flushAudit();
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(e).toMatchObject({ actorUserId: 7, actorLabel: "ann", actorKind: "user", action: "users.resetPassword", targetType: "user", targetId: "9" });
    expect(e?.userAgentHash).toMatch(/^[0-9a-f]{16}$/);
    const lines = fs.readFileSync(auditFile(), "utf8").trim().split("\n");
    const last = JSON.parse(lines.at(-1)!) as Row;
    expect(last).toMatchObject({ id: e!.id, action: "users.resetPassword", hash: e!.hash, after: { username: "bob", password: "[redacted]" } });
    expect(lines.join("\n")).not.toContain("SECRET");
  });
});
