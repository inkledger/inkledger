import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "inkledger-modules-"));
const KEY = generateKeyPairSync("ed25519");
const FOREIGN = generateKeyPairSync("ed25519");
process.env.DATABASE_URL = ":memory:";
process.env.MODULES_DIR = DIR;
process.env.MODULES_TRUST_EXTRA_KEY = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import { signEnvelope } from "../vendor/seal/envelope.ts";
import { signManifest, sha256hex } from "../vendor/seal/package.ts";
import { LICENSE_CONTEXT, PACKAGE_CONTEXT } from "@contracts/modules";

const SITE = "https://acme.atlassian.net";
const ENTRY = "export default { id: 'hello', hostApi: 1, mount: {} };\n";

type Signer = typeof KEY;

function license(product: string, signer: Signer = KEY, extra: Record<string, unknown> = {}) {
  const payload = { id: `L-${product}`, email_hash: "h", product, issued: 1, v: 1, ...extra };
  return signEnvelope(Buffer.from(JSON.stringify(payload)), LICENSE_CONTEXT, signer.privateKey);
}

function manifestFor(files: Record<string, string>, over: Record<string, unknown> = {}) {
  return {
    id: "hello",
    version: "1.0.0",
    product: "inkledger.hello",
    entry: "index.js",
    hostApi: { min: 1, max: 1 },
    slots: ["sidebar-footer"],
    name: { en: "Hello", it: "Ciao" },
    files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha256hex(Buffer.from(c))])),
    ...over,
  };
}

/** A bundle as `seal pack` writes it. */
function bundle(files: Record<string, string> = { "index.js": ENTRY }, over: Record<string, unknown> = {}, signer: Signer = KEY) {
  const manifest = manifestFor(files, over);
  const signature = signManifest(manifest, PACKAGE_CONTEXT, signer.privateKey);
  return {
    format: "seal-bundle-v1",
    manifest,
    signature,
    files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, Buffer.from(c).toString("base64")])),
  };
}

describe("add-on modules", () => {
  let cookie = "";
  let app: typeof import("../boot").default;
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let userId: number;

  const upload = (body: unknown, query = "") =>
    app.request(`/api/modules/upload${query}`, { method: "POST", body: JSON.stringify(body), headers: { cookie } });

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input).endsWith("/rest/api/3/myself")
        ? new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario" }), { headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 500 }),
    );
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    app = (await import("../boot")).default;
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
    userId = ctx.user!.id;
  });

  beforeEach(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR);
    const { saveLicenses } = await import("./registry");
    await saveLicenses([]);
  });

  it("vendored seal matches its SHA256SUMS (edit it in seal, then sync)", () => {
    const dir = path.join(import.meta.dirname, "../vendor/seal");
    const lines = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
    for (const line of lines) {
      const [hash, file] = line.split(/\s+/);
      expect(createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"), file).toBe(hash);
    }
  });

  it("installs a signed bundle, which needs a licence to load", async () => {
    const res = await upload(bundle());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "hello", version: "1.0.0" });
    let [m] = (await caller.modules.list()).modules;
    expect(m.status).toEqual({ state: "needs-license" });
    expect(m.entryUrl).toBeNull();

    await (await import("./registry")).addLicense(license("inkledger.hello"));
    const list = await caller.modules.list();
    [m] = list.modules;
    expect(m.status).toEqual({ state: "active" });
    expect(list.extraKey).toBe(true);
    expect(list.licenses).toEqual([expect.objectContaining({ product: "inkledger.hello" })]);
    expect(m.integrity).toBe(`sha256-${createHash("sha256").update(ENTRY).digest("base64")}`);

    const js = await app.request(m.entryUrl ?? "", { headers: { cookie } });
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe(ENTRY);
    expect((await app.request(m.entryUrl ?? "")).status).toBe(401);
    const stale = (m.entryUrl ?? "").replace(/\/[0-9a-f]{32}\//, `/${"0".repeat(32)}/`);
    expect((await app.request(stale, { headers: { cookie } })).status).toBe(404);
  });

  it("refuses licences that are forged, foreign or from the future", async () => {
    const { addLicense } = await import("./registry");
    expect((await addLicense(license("inkledger.hello", FOREIGN))).ok).toBe(false);
    expect((await addLicense("nonsense")).ok).toBe(false);
    expect((await addLicense(license("inkledger.hello", KEY, { v: 2 }))).ok).toBe(false);
    // Another app's context with the same key does not verify here.
    const agbr = signEnvelope(Buffer.from(JSON.stringify({ id: "x", email_hash: "h", product: "inkledger.hello", issued: 1, v: 1 })), "agbr-licenza-v1\n", KEY.privateKey);
    expect((await addLicense(agbr)).ok).toBe(false);
  });

  it("refuses uploads not signed by a trusted key, or not matching their manifest", async () => {
    expect((await upload(bundle({ "index.js": ENTRY }, {}, FOREIGN))).status).toBe(400);
    const tampered = bundle();
    tampered.files["index.js"] = Buffer.from("alert(1)").toString("base64");
    expect(await (await upload(tampered)).json()).toMatchObject({ ok: false, reason: "mismatch" });
    const extra = bundle();
    (extra.files as Record<string, string>)["evil.js"] = Buffer.from("x").toString("base64");
    expect(await (await upload(extra)).json()).toMatchObject({ ok: false, reason: "extra" });
    const escape = bundle({ "index.js": ENTRY, "../x.js": "x" });
    expect(await (await upload(escape)).json()).toMatchObject({ ok: false });
    expect(await (await upload(bundle({ "index.js": ENTRY }, { product: "inkledger.other" }))).json()).toMatchObject({ ok: false, reason: "manifest-invalid" });
    expect(await (await upload(bundle({ "index.js": ENTRY }, { extra: 1 }))).json()).toMatchObject({ ok: false, reason: "manifest-invalid" });
    expect((await app.request("/api/modules/upload", { method: "POST", body: JSON.stringify(bundle()) })).status).toBe(401);
    expect(fs.readdirSync(DIR)).toEqual([]);
  });

  it("installs only for who manages the store, and nothing until a forced password change is done", async () => {
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    try {
      await getDb().update(users).set({ role: "member", permissions: "[]" }).where(eq(users.id, userId));
      expect((await upload(bundle())).status).toBe(403);
      await getDb().update(users).set({ role: "admin", mustChangePassword: 1 }).where(eq(users.id, userId));
      expect((await upload(bundle())).status).toBe(403);
      expect(fs.readdirSync(DIR)).toEqual([]);
    } finally {
      await getDb().update(users).set({ role: "admin", mustChangePassword: 0 }).where(eq(users.id, userId));
    }
  });

  it("runs nothing for an account that may not use modules (useModules)", async () => {
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const { userFromRequest } = await import("../context");
    const { appRouter } = await import("../router");
    try {
      await getDb().update(users).set({ role: "member", permissions: "[]" }).where(eq(users.id, userId));
      const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
      const member = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
      expect((await member.modules.list()).canUse).toBe(false);
      await expect(member.modules.storageGet({ moduleId: "hello", key: "k" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await app.request("/api/modules/hello/abc/index.js", { headers: { cookie } })).status).toBe(403);
      // The data migration grants it to the accounts from before.
      const { runDataMigrations } = await import("../queries/dataMigrations");
      const { serverSettings } = await import("@db/schema");
      await getDb().delete(serverSettings).where(eq(serverSettings.key, "data-migrations.done"));
      await runDataMigrations(getDb());
      const [after] = await getDb().select({ permissions: users.permissions }).from(users).where(eq(users.id, userId));
      expect(JSON.parse(after.permissions)).toContain("useModules");
    } finally {
      await getDb().update(users).set({ role: "admin", permissions: "[]" }).where(eq(users.id, userId));
    }
  });

  it("refuses an upload from another origin (CSRF)", async () => {
    const res = await app.request("/api/modules/upload", {
      method: "POST",
      body: JSON.stringify(bundle()),
      headers: { cookie, origin: "https://evil.example", host: "localhost" },
    });
    expect(res.status).toBe(403);
  });

  it("keeps a newer version unless forced, and replaces atomically", async () => {
    await upload(bundle({ "index.js": ENTRY }, { version: "2.0.0" }));
    expect(await (await upload(bundle())).json()).toMatchObject({ ok: false, reason: "older-version" });
    expect(await (await upload(bundle(), "?force=1")).json()).toMatchObject({ ok: true, version: "1.0.0" });
    expect(fs.readdirSync(DIR)).toEqual(["hello"]);
  });

  it("a file changed on disk after install stops the module", async () => {
    await upload(bundle());
    await (await import("./registry")).addLicense(license("inkledger.hello"));
    fs.writeFileSync(path.join(DIR, "hello/index.js"), "alert(1)");
    const [m] = (await caller.modules.list()).modules;
    expect(m.status).toEqual({ state: "invalid", reason: "mismatch" });
    fs.writeFileSync(path.join(DIR, "hello/index.js"), ENTRY);
    fs.symlinkSync("/etc/hosts", path.join(DIR, "hello/link.js"));
    expect((await caller.modules.list()).modules[0].status).toMatchObject({ state: "invalid" });
  });

  it("an unsupported host API version is never installed, and one already there is not loaded", async () => {
    const future = bundle({ "index.js": ENTRY }, { hostApi: { min: 2, max: 3 } });
    expect(await (await upload(future)).json()).toEqual({ ok: false, reason: "incompatible-host" });
    // As an older inkledger left it on disk (the server was downgraded).
    fs.mkdirSync(path.join(DIR, "hello"));
    fs.writeFileSync(path.join(DIR, "hello/manifest.json"), JSON.stringify(future.manifest));
    fs.writeFileSync(path.join(DIR, "hello/manifest.sig"), String(future.signature));
    fs.writeFileSync(path.join(DIR, "hello/index.js"), ENTRY);
    await (await import("./registry")).addLicense(license("inkledger.hello"));
    expect((await caller.modules.list()).modules[0].status).toEqual({ state: "unsupported-host-api" });
  });

  it("an update this inkledger can't run never replaces the working module", async () => {
    await upload(bundle());
    await (await import("./registry")).addLicense(license("inkledger.hello"));
    expect(await (await upload(bundle({ "index.js": ENTRY }, { version: "2.0.0", hostApi: { min: 2, max: 2 } }))).json()).toEqual({ ok: false, reason: "incompatible-host" });
    const [m] = (await caller.modules.list()).modules;
    expect(m).toMatchObject({ version: "1.0.0", status: { state: "active" } });
  });

  it("a licence holds for every version of its product, older or newer than when it was bought", async () => {
    const { addLicense } = await import("./registry");
    await addLicense(license("inkledger.hello", KEY, { issued: Date.parse("2026-01-01") }));
    for (const version of ["1.0.0", "2.3.0", "10.0.1"]) {
      expect(await (await upload(bundle({ "index.js": ENTRY }, { version }), "?force=1")).json()).toMatchObject({ ok: true, version });
      expect((await caller.modules.list()).modules[0]).toMatchObject({ version, status: { state: "active" } });
    }
    expect(await (await upload(bundle(), "?force=1")).json()).toMatchObject({ ok: true, version: "1.0.0" });
    expect((await caller.modules.list()).modules[0].status).toEqual({ state: "active" });
  });

  it("a rebuild keeps its version but not its build id", async () => {
    await upload(bundle());
    const first = (await caller.modules.list()).modules[0].build;
    await upload(bundle({ "index.js": `${ENTRY}// fix\n` }));
    const second = (await caller.modules.list()).modules[0];
    expect(second.version).toBe("1.0.0");
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second.build).not.toBe(first);
  });

  it("licence issuers only grow: every key that ever signed a sold licence stays trusted", async () => {
    const { LICENSE_ISSUERS, LICENSE_KEYS } = await import("./keys");
    // Fingerprints of the issuer keys shipped so far; a rotation adds, never removes.
    const shipped = {
      publisher: "MCowBQYDK2VwAyEA1etNGb4TL2Eeu60uWvKF9YvAvz3s0dXPL/rAhXx7OQQ=",
      store: "MCowBQYDK2VwAyEAMc/6TUxBGEtXwPo0Bv99lIeWTIRSjAGIjM/5slACI8g=",
      inbox: "MCowBQYDK2VwAyEAZYHt7yKtYAV5zl3nWxmoyR9LWCXFkjVbCA1GoVGCj/E=",
    };
    for (const [name, body] of Object.entries(shipped)) {
      expect(LICENSE_ISSUERS[name as keyof typeof LICENSE_ISSUERS], name).toContain(body);
      expect(LICENSE_KEYS.some((k) => k.includes(body)), name).toBe(true);
    }
  });

  it("storage: per module, only while active, with limits", async () => {
    await expect(caller.modules.storageSet({ moduleId: "hello", key: "k", value: 1 })).rejects.toThrow();
    await upload(bundle());
    await (await import("./registry")).addLicense(license("inkledger.hello"));
    await caller.modules.storageSet({ moduleId: "hello", key: "state", value: { stage: "egg" } });
    expect(await caller.modules.storageGet({ moduleId: "hello", key: "state" })).toMatchObject({ value: { stage: "egg" } });
    await expect(caller.modules.storageSet({ moduleId: "hello", key: "big", value: "x".repeat(20_000) })).rejects.toThrow();
    await caller.modules.storageDelete({ moduleId: "hello", key: "state" });
    expect((await caller.modules.storageGet({ moduleId: "hello", key: "state" })).value).toBeNull();
    for (let i = 0; i < 64; i++) await caller.modules.storageSet({ moduleId: "hello", key: `k${i}`, value: i });
    await expect(caller.modules.storageSet({ moduleId: "hello", key: "one-more", value: 1 })).rejects.toThrow();
    await caller.modules.storageSet({ moduleId: "hello", key: "k0", value: "overwrite is fine" });
  });

  it("files: a cache per module, only while active, evicted by last use, by age and on uninstall", async () => {
    const png = (n: number, fill = 1) => Buffer.alloc(n, fill).toString("base64");
    const ref = { moduleId: "hello", contentType: "image/webp" as const };
    await expect(caller.modules.filePut({ ...ref, key: "a", data: png(10) })).rejects.toThrow();
    await upload(bundle());
    await (await import("./registry")).addLicense(license("inkledger.hello"));
    const files = await import("./files");
    const { FILES_MAX_COUNT, FILES_MAX_TOTAL_BYTES, FILES_MAX_IDLE_MS } = await import("@contracts/modules");
    const me = (await import("../queries/connection")).getDb();
    const { moduleFiles, users } = await import("@db/schema");
    const [u] = await me.select({ id: users.id }).from(users).limit(1);

    await caller.modules.filePut({ ...ref, key: "tree|1", data: png(1000, 7) });
    expect(await caller.modules.fileGet({ moduleId: "hello", key: "tree|1" })).toEqual({ contentType: "image/webp", data: png(1000, 7) });
    expect(await caller.modules.fileGet({ moduleId: "hello", key: "missing" })).toBeNull();
    await expect(caller.modules.filePut({ ...ref, key: "big", data: png(600 * 1024) })).rejects.toThrow();
    await expect(caller.modules.filePut({ moduleId: "hello", key: "x", contentType: "text/html" as never, data: png(10) })).rejects.toThrow();

    // Count cap: the least recently used goes; one read keeps a file.
    for (let i = 0; i < FILES_MAX_COUNT; i++) await caller.modules.filePut({ ...ref, key: `f${i}`, data: png(100) });
    await caller.modules.fileGet({ moduleId: "hello", key: "f0" });
    await caller.modules.filePut({ ...ref, key: "newest", data: png(100) });
    const usage = await files.moduleFilesUsage(u.id, "hello");
    expect(usage.count).toBe(FILES_MAX_COUNT);
    expect(await caller.modules.fileGet({ moduleId: "hello", key: "f0" })).not.toBeNull();
    expect(await caller.modules.fileGet({ moduleId: "hello", key: "newest" })).not.toBeNull();

    // Size cap.
    const big = Math.ceil(FILES_MAX_TOTAL_BYTES / (500 * 1024)) + 1;
    for (let i = 0; i < big; i++) await caller.modules.filePut({ ...ref, key: `big${i}`, data: png(500 * 1024) });
    expect((await files.moduleFilesUsage(u.id, "hello")).bytes).toBeLessThanOrEqual(FILES_MAX_TOTAL_BYTES);

    // Idle for a month: gone.
    await me.update(moduleFiles).set({ usedAt: new Date(Date.now() - FILES_MAX_IDLE_MS - 1000) });
    await caller.modules.filePut({ ...ref, key: "fresh", data: png(10) });
    await files.purgeIdleModuleFiles();
    expect((await files.moduleFilesUsage(u.id, "hello")).count).toBe(1);

    // Uninstall: every file of the module goes.
    await caller.modules.uninstall({ id: "hello" });
    expect((await files.moduleFilesUsage(u.id, "hello")).count).toBe(0);
  });

  it("uninstall removes the module", async () => {
    await upload(bundle());
    expect(await caller.modules.uninstall({ id: "hello" })).toEqual({ removed: true });
    expect((await caller.modules.list()).modules).toEqual([]);
  });

  it("no private key is ever committed", async () => {
    const { spawnSync } = await import("node:child_process");
    // Tracked and untracked files, ignored ones aside; exit 1 means no match.
    const marker = ["BEGIN", "PRIVATE KEY"].join(" (OPENSSH )?");
    const r = spawnSync("git", ["grep", "--untracked", "-l", "-E", marker, "--", "."], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf8",
    });
    expect(r.status, r.stdout).toBe(1);
  });

  it("the shipped keys are usable Ed25519 keys; a bare base64 one is accepted", async () => {
    const { PACKAGE_KEYS, LICENSE_KEYS, asPem } = await import("./keys");
    const { loadPublicKey } = await import("../vendor/seal/keys.ts");
    expect(PACKAGE_KEYS.length).toBeGreaterThan(0);
    for (const k of [...PACKAGE_KEYS, ...LICENSE_KEYS]) expect(loadPublicKey(asPem(k)).ok).toBe(true);
    const bare = FOREIGN.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(loadPublicKey(asPem(bare)).ok).toBe(true);
  });

  it("an online licence key never signs packages", async () => {
    const { PACKAGE_KEYS, LICENSE_KEYS } = await import("./keys");
    // Only the offline publisher key is in both lists.
    expect(LICENSE_KEYS.filter((k) => PACKAGE_KEYS.includes(k))).toEqual([...PACKAGE_KEYS]);
    expect(LICENSE_KEYS.length).toBeGreaterThan(PACKAGE_KEYS.length);
  });

  const activate = async (fresh = true) => {
    if (fresh) {
      const { getDb } = await import("../queries/connection");
      const { moduleStorage } = await import("@db/schema");
      await getDb().delete(moduleStorage);
    }
    await upload(bundle());
    await (await import("./registry")).addLicense(license("inkledger.hello"));
  };

  it("totals count only what was logged since the module started counting", async () => {
    await activate();
    const { getDb } = await import("../queries/connection");
    const { worklogs } = await import("@db/schema");
    const at = (ms: number) => ({ userId, issueKey: "OPS-1", remoteId: `w${ms}`, timeSpentSeconds: 3600, started: new Date(ms) });
    await getDb().insert(worklogs).values(at(Date.now() - 86_400_000)); // before install
    const first = await caller.modules.totals({ moduleId: "hello" });
    expect(first.lifetimeLoggedSeconds).toBe(0);
    await getDb().insert(worklogs).values(at(first.since + 1000));
    expect(await caller.modules.totals({ moduleId: "hello" })).toEqual({ lifetimeLoggedSeconds: 3600, weekLoggedSeconds: 3600, since: first.since });
  });

  it("a user can switch one module off and on; progress import keeps the switch", async () => {
    await activate();
    expect((await caller.modules.list()).off).toEqual([]);
    await caller.modules.setEnabled({ id: "hello", enabled: false });
    expect((await caller.modules.list()).off).toEqual(["hello"]);
    const file = await caller.modules.exportProgress({ id: "hello" });
    await caller.modules.importProgress({ text: JSON.stringify(file) });
    expect((await caller.modules.list()).off).toEqual(["hello"]);
    await caller.modules.setEnabled({ id: "hello", enabled: true });
    expect((await caller.modules.list()).off).toEqual([]);
  });

  it("totals give this week apart, from Monday when the module counts all history", async () => {
    await activate();
    const { getDb } = await import("../queries/connection");
    const { worklogs, moduleStorage } = await import("@db/schema");
    const { startOfWeek } = await import("@contracts/time");
    await caller.modules.totals({ moduleId: "hello" });
    await getDb().update(moduleStorage).set({ value: "0" }).where(eq(moduleStorage.key, "__since"));
    const monday = startOfWeek(new Date()).getTime();
    const log = (ms: number, id: string) => ({ userId, issueKey: "OPS-2", remoteId: id, timeSpentSeconds: 1800, started: new Date(ms) });
    await getDb().insert(worklogs).values([log(monday - 86_400_000, "last-week"), log(monday + 60_000, "this-week")]);
    const t = await caller.modules.totals({ moduleId: "hello" });
    expect(t.since).toBe(0);
    expect(t.lifetimeLoggedSeconds - t.weekLoggedSeconds).toBeGreaterThanOrEqual(1800);
    expect(t.weekLoggedSeconds).toBeGreaterThanOrEqual(1800);
  });

  it("history: hours per local day, from since, never before the module counts", async () => {
    await activate();
    const { getDb } = await import("../queries/connection");
    const { worklogs, moduleStorage } = await import("@db/schema");
    await caller.modules.totals({ moduleId: "hello" });
    const DAY = 86_400_000;
    const noon = (daysAgo: number) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      return d.getTime() - daysAgo * DAY;
    };
    const ymd = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const log = (ms: number, id: string, s = 1800) => ({ userId, issueKey: "OPS-3", remoteId: id, timeSpentSeconds: s, started: new Date(ms) });
    // Days no other test of this file logs on (they log today and around Monday).
    await getDb().insert(worklogs).values([log(noon(40), "h-old"), log(noon(10), "h-a"), log(noon(10) + 3600_000, "h-b", 600), log(noon(9), "h-c")]);
    // Counting from 10 days ago: the 40-day-old log is out.
    await getDb().update(moduleStorage).set({ value: String(noon(11)) }).where(eq(moduleStorage.key, "__since"));
    const days = await caller.modules.historyDaily({ moduleId: "hello" });
    expect(days.filter((d) => d.date >= ymd(noon(11)) && d.date <= ymd(noon(9)))).toEqual([
      { date: ymd(noon(10)), seconds: 2400 },
      { date: ymd(noon(9)), seconds: 1800 },
    ]);
    expect(days.some((d) => d.date === ymd(noon(40)))).toBe(false);
    // A later since narrows it; an earlier one can't widen it.
    expect((await caller.modules.historyDaily({ moduleId: "hello", since: noon(9) - 3600_000 })).map((d) => d.date)).not.toContain(ymd(noon(10)));
    expect((await caller.modules.historyDaily({ moduleId: "hello", since: 0 })).map((d) => d.date)).not.toContain(ymd(noon(40)));
  });

  it("storage revisions: a write over a value read before another write is refused with the latest; an import bumps them", async () => {
    await activate();
    const first = await caller.modules.storageGet({ moduleId: "hello", key: "state" });
    expect(first).toEqual({ value: null, revision: 0 });
    expect(await caller.modules.storageSetIf({ moduleId: "hello", key: "state", value: { n: 1 }, ifRevision: 0 })).toEqual({ revision: 1 });
    // Another tab read revision 0 too: its write is refused, with what is there now.
    expect(await caller.modules.storageSetIf({ moduleId: "hello", key: "state", value: { n: 9 }, ifRevision: 0 })).toEqual({ conflict: true, value: { n: 1 }, revision: 1 });
    // A plain write (older hosts) still goes, and moves the revision on.
    await caller.modules.storageSet({ moduleId: "hello", key: "state", value: { n: 2 } });
    expect((await caller.modules.storageGet({ moduleId: "hello", key: "state" })).revision).toBe(2);
    const file = await caller.modules.exportProgress({ id: "hello" });
    expect(JSON.stringify(file)).not.toContain("revision");
    await caller.modules.importProgress({ text: JSON.stringify(file) });
    const after = await caller.modules.storageGet({ moduleId: "hello", key: "state" });
    expect(after.value).toEqual({ n: 2 });
    expect(after.revision).toBeGreaterThan(2);
  });

  it("host keys are reserved and don't count toward the limit", async () => {
    await activate();
    await expect(caller.modules.storageSet({ moduleId: "hello", key: "__since", value: 0 })).rejects.toThrow();
    await caller.modules.totals({ moduleId: "hello" });
    for (let i = 0; i < 64; i++) await caller.modules.storageSet({ moduleId: "hello", key: `k${i}`, value: i });
  });

  it("progress: export, uninstall wipes it, reinstall starts from zero, import brings it back", async () => {
    await activate();
    const { since } = await caller.modules.totals({ moduleId: "hello" });
    await caller.modules.storageSet({ moduleId: "hello", key: "state", value: { stage: "adult" } });
    const file = await caller.modules.exportProgress({ id: "hello" });
    expect(file).toMatchObject({ format: "inkledger-progress-v1", module: "hello", since, data: { state: { stage: "adult" } } });

    await caller.modules.uninstall({ id: "hello" });
    await activate(false);
    expect((await caller.modules.storageGet({ moduleId: "hello", key: "state" })).value).toBeNull();
    expect((await caller.modules.totals({ moduleId: "hello" })).since).toBeGreaterThanOrEqual(since);

    await expect(caller.modules.importProgress({ text: JSON.stringify({ ...file, data: { state: { stage: "legend" } } }) })).rejects.toThrow();
    await expect(caller.modules.importProgress({ text: "nonsense" })).rejects.toThrow();
    await caller.modules.importProgress({ text: JSON.stringify(file) });
    expect(await caller.modules.storageGet({ moduleId: "hello", key: "state" })).toMatchObject({ value: { stage: "adult" } });
    expect((await caller.modules.totals({ moduleId: "hello" })).since).toBe(since);
  });
});
