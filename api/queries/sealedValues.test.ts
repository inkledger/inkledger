import { describe, expect, it } from "vitest";
import { fromHex, fromSecret, hexKey, legacyText, sealedBytes, sealedText } from "../testing/sealedFixtures";

// A server mid-rotation: a new CREDENTIALS_KEY, the previous one as _OLD, and
// values still sealed with the key derived from SESSION_SECRET (before any CREDENTIALS_KEY).
const NEW = hexKey();
const OLD = hexKey();
const SESSION = "a-session-secret-for-these-tests";
process.env.DATABASE_URL = ":memory:";
process.env.CREDENTIALS_KEY = NEW;
process.env.CREDENTIALS_KEY_OLD = OLD;
process.env.SESSION_SECRET = SESSION;

const keys = { NEW: fromHex(NEW), OLD: fromHex(OLD), SESSION: fromSecret(SESSION), LOST: fromHex(hexKey()) };

async function seed() {
  const { resetDbForTests, q } = await import("./connection");
  await resetDbForTests();
  await q("INSERT INTO users (id, username, display_name, created_at) VALUES (1, 'm', 'M', 0), (2, 'n', 'N', 0)");
  const conn = (id: number, secret: string, webhook: string | null = null, status = "ok") =>
    q(
      "INSERT INTO connections (id, user_id, type, base_url, remote_account_id, options, encrypted_secret, webhook_secret, status, created_at) VALUES (?, 1, 'jira', ?, 'me', '{}', ?, ?, ?, 0)",
      id, `https://s${id}.example`, secret, webhook, status,
    );
  await conn(1, sealedText(keys.NEW, "t1", "connection:1"));
  await conn(2, sealedText(keys.OLD, "t2", "connection:2"), sealedText(keys.OLD, "h2", "connection:2"));
  await conn(3, sealedText(keys.SESSION, "t3", "connection:3"));
  await conn(4, legacyText(keys.SESSION, "t4"));
  await conn(5, sealedText(keys.LOST, "t5", "connection:5"), null, "unreadable");
  // Sealed for another connection: the binding refuses it whatever the key.
  await conn(6, sealedText(keys.NEW, "t6", "connection:99"));
  await conn(7, sealedText(keys.OLD, "t7", "connection:7"), null, "unreadable");
  await q("INSERT INTO mail_accounts (user_id, account, secret, created_at, updated_at) VALUES (1, 'm@x', ?, 0, 0), (2, 'n@x', ?, 0, 0)",
    sealedText(keys.SESSION, '{"a":1}', "mail:1"), sealedText(keys.NEW, '{"a":2}', "mail:2"));
  await q("INSERT INTO mails (id, user_id, source, created_at, updated_at) VALUES (10, 1, 'eml', 0, 0), (11, 1, 'eml', 0, 0)");
  await q("INSERT INTO mail_copies (mail_id, user_id, mode, sealed, plain_sha256, plain_bytes, source, captured_at) VALUES (10, 1, 'full', ?, 'x', 3, 'eml', 0), (11, 1, 'full', ?, 'x', 3, 'eml', 0)",
    sealedBytes(keys.OLD, Buffer.from("eml"), "mailcopy:1:10"), sealedBytes(keys.LOST, Buffer.from("eml"), "mailcopy:1:11"));
  await q("INSERT INTO ideas (id, user_id, title, created_at, updated_at) VALUES (20, 1, 'i', 0, 0)");
  await q("INSERT INTO idea_files (id, user_id, idea_id, name, content_type, size, data, created_at) VALUES (30, 1, 20, 'p.png', 'image/png', 3, ?, 0)",
    sealedBytes(keys.SESSION, Buffer.from("png"), "idea-file:1:30"));
  // The alert webhook: its URL and signing secret, sealed together.
  await q("INSERT INTO server_settings (key, value, updated_at) VALUES ('alerts.webhook', ?, 0)",
    JSON.stringify({ url: sealedText(keys.OLD, "https://hooks.example/x", "alerts:webhook"), secret: sealedText(keys.OLD, "s1", "alerts:webhook"), format: "json" }));
  // The off-site backup secret, beside its plain settings.
  await q("INSERT INTO server_settings (key, value, updated_at) VALUES ('backup.offsite', ?, 0)",
    JSON.stringify({ kind: "s3", bucket: "b", secret: sealedText(keys.OLD, "s3-secret", "backup:offsite") }));
}

describe("keys-status and reseal on values sealed with older keys", () => {
  it("counts, per sealed column, the values each key opens and those none does, with what to fix first", async () => {
    await seed();
    const { getDb } = await import("./connection");
    const { keysStatus } = await import("./sealedValues");
    const s = await keysStatus(getDb());
    expect(s.sealingKey).toBe("CREDENTIALS_KEY");
    const by = Object.fromEntries(s.columns.map(({ column, ...rest }) => [column, rest]));
    expect(by).toEqual({
      "connections.encrypted_secret": { total: 7, CREDENTIALS_KEY: 1, CREDENTIALS_KEY_OLD: 2, SESSION_SECRET: 2, unreadable: 2 },
      "connections.webhook_secret": { total: 1, CREDENTIALS_KEY: 0, CREDENTIALS_KEY_OLD: 1, SESSION_SECRET: 0, unreadable: 0 },
      "mail_accounts.secret": { total: 2, CREDENTIALS_KEY: 1, CREDENTIALS_KEY_OLD: 0, SESSION_SECRET: 1, unreadable: 0 },
      "mail_copies.sealed": { total: 2, CREDENTIALS_KEY: 0, CREDENTIALS_KEY_OLD: 1, SESSION_SECRET: 0, unreadable: 1 },
      "idea_files.data": { total: 1, CREDENTIALS_KEY: 0, CREDENTIALS_KEY_OLD: 0, SESSION_SECRET: 1, unreadable: 0 },
      "server_settings.alerts.webhook": { total: 1, CREDENTIALS_KEY: 0, CREDENTIALS_KEY_OLD: 1, SESSION_SECRET: 0, unreadable: 0 },
      "server_settings.backup.offsite": { total: 1, CREDENTIALS_KEY: 0, CREDENTIALS_KEY_OLD: 1, SESSION_SECRET: 0, unreadable: 0 },
    });
    expect(s.warnings.join("\n")).toMatch(/4 value\(s\) still open only with the key derived from SESSION_SECRET/);
    expect(s.warnings.join("\n")).toMatch(/6 value\(s\) still need CREDENTIALS_KEY_OLD/);
    expect(s.warnings.join("\n")).toMatch(/3 value\(s\) open with no configured key/);
  });

  it("a dry run counts what it would seal again and lists unreadable rows, writing nothing", async () => {
    const { getDb, q } = await import("./connection");
    const { resealAll } = await import("./sealedValues");
    const before = await q("SELECT id, encrypted_secret, webhook_secret, status FROM connections ORDER BY id");
    const r = await resealAll(getDb(), { apply: false });
    expect(r.applied).toBe(false);
    expect(r.columns).toEqual([
      { column: "connections.encrypted_secret", current: 1, resealed: 4, changed: 0, unreadable: [5, 6] },
      { column: "connections.webhook_secret", current: 0, resealed: 1, changed: 0, unreadable: [] },
      { column: "mail_accounts.secret", current: 1, resealed: 1, changed: 0, unreadable: [] },
      { column: "mail_copies.sealed", current: 0, resealed: 1, changed: 0, unreadable: [11] },
      { column: "idea_files.data", current: 0, resealed: 1, changed: 0, unreadable: [] },
      { column: "server_settings.alerts.webhook", current: 0, resealed: 1, changed: 0, unreadable: [] },
      { column: "server_settings.backup.offsite", current: 0, resealed: 1, changed: 0, unreadable: [] },
    ]);
    expect(await q("SELECT id, encrypted_secret, webhook_secret, status FROM connections ORDER BY id")).toEqual(before);
  });

  it("--apply seals every readable value with CREDENTIALS_KEY, leaves the rest, and nothing then needs the older keys", async () => {
    const { getDb, q } = await import("./connection");
    const { resealAll, keysStatus } = await import("./sealedValues");
    const { openSecret, openFor, openBytesFor } = await import("../lib/crypto");
    const unreadable = (await q<{ encrypted_secret: string }>("SELECT encrypted_secret FROM connections WHERE id = 5"))[0].encrypted_secret;
    const r = await resealAll(getDb(), { apply: true });
    expect(r.columns.map((c) => [c.column, c.resealed, c.unreadable])).toEqual([
      ["connections.encrypted_secret", 4, [5, 6]],
      ["connections.webhook_secret", 1, []],
      ["mail_accounts.secret", 1, []],
      ["mail_copies.sealed", 1, [11]],
      ["idea_files.data", 1, []],
      ["server_settings.alerts.webhook", 1, []],
      ["server_settings.backup.offsite", 1, []],
    ]);
    const conns = await q<{ id: number; encrypted_secret: string; webhook_secret: string | null; status: string }>("SELECT id, encrypted_secret, webhook_secret, status FROM connections ORDER BY id");
    for (const c of conns.filter((c) => [1, 2, 3, 4, 7].includes(c.id))) expect(openSecret(c.encrypted_secret, c.id)).toEqual({ plain: `t${c.id}`, fresh: true });
    expect(openSecret(conns[1].webhook_secret ?? "", 2)).toEqual({ plain: "h2", fresh: true });
    // Unreadable because no key opened it: it opens now, so it works again. One no key opens is left untouched.
    expect(conns.find((c) => c.id === 7)?.status).toBe("ok");
    expect(conns.find((c) => c.id === 5)).toMatchObject({ encrypted_secret: unreadable, status: "unreadable" });
    const [mail] = await q<{ secret: string }>("SELECT secret FROM mail_accounts WHERE user_id = 1");
    expect(openFor(mail.secret, "mail:1")).toBe('{"a":1}');
    const [copy] = await q<{ sealed: Buffer }>("SELECT sealed FROM mail_copies WHERE mail_id = 10");
    expect(openBytesFor(Buffer.from(copy.sealed), "mailcopy:1:10").toString()).toBe("eml");
    const [file] = await q<{ data: Buffer }>("SELECT data FROM idea_files WHERE id = 30");
    expect(openBytesFor(Buffer.from(file.data), "idea-file:1:30").toString()).toBe("png");
    const [hook] = await q<{ value: string }>("SELECT value FROM server_settings WHERE key = 'alerts.webhook'");
    const sealedHook = JSON.parse(hook.value) as { url: string; secret: string; format: string };
    expect([openFor(sealedHook.url, "alerts:webhook"), openFor(sealedHook.secret, "alerts:webhook"), sealedHook.format]).toEqual(["https://hooks.example/x", "s1", "json"]);
    const [offsite] = await q<{ value: string }>("SELECT value FROM server_settings WHERE key = 'backup.offsite'");
    const sealedOffsite = JSON.parse(offsite.value) as { kind: string; secret: string };
    expect([sealedOffsite.kind, openFor(sealedOffsite.secret, "backup:offsite")]).toEqual(["s3", "s3-secret"]);

    const s = await keysStatus(getDb());
    expect(s.columns.reduce((n, c) => n + c.CREDENTIALS_KEY_OLD + c.SESSION_SECRET, 0)).toBe(0);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/3 value\(s\) open with no configured key/);
    expect((await resealAll(getDb(), { apply: true })).columns.every((c) => c.resealed === 0)).toBe(true);
  });

  it("a value the server rewrote between the read and the write is skipped, not overwritten", async () => {
    const { getDb, q } = await import("./connection");
    const { resealAll } = await import("./sealedValues");
    await q("UPDATE mail_accounts SET secret = ? WHERE user_id = 1", sealedText(keys.OLD, '{"a":3}', "mail:1"));
    const db = getDb();
    // The running server refreshes the sign-in right after reseal read it.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (table: unknown) => {
            void q("UPDATE mail_accounts SET secret = ? WHERE user_id = 1", sealedText(keys.NEW, '{"a":4}', "mail:1"));
            return (target.update as (t: unknown) => unknown).call(target, table);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const r = await resealAll(racing, { apply: true });
    expect(r.columns.find((c) => c.column === "mail_accounts.secret")).toMatchObject({ resealed: 0, changed: 1 });
    const { openFor } = await import("../lib/crypto");
    const [mail] = await q<{ secret: string }>("SELECT secret FROM mail_accounts WHERE user_id = 1");
    expect(openFor(mail.secret, "mail:1")).toBe('{"a":4}');
  });
});
