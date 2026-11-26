import { describe, it, expect, beforeAll, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-store-perm-"));
const KEY = generateKeyPairSync("ed25519");
process.env.DATABASE_URL = ":memory:";
process.env.MODULES_DIR = DIR;
process.env.MODULES_TRUST_EXTRA_KEY = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.STORE_URL = "https://store.test";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import { signEnvelope } from "../vendor/seal/envelope.ts";
import { signManifest, sha256hex } from "../vendor/seal/package.ts";
import { LICENSE_CONTEXT, PACKAGE_CONTEXT } from "@contracts/modules";
import type { Permission } from "@contracts/accounts";

/**
 * Who does what in the Store (contracts/accounts.ts): useModules with a module granted
 * turns it on or off and sets it up, nothing else; acquireModules browses the catalogue
 * and gets a module not on the server yet, granted then to them alone; manageStore, all.
 */

const ENTRY = "export default { id: 'hello', hostApi: 1, mount: {} };\n";
const license = (product: string) =>
  signEnvelope(Buffer.from(JSON.stringify({ id: "R-" + product, email_hash: "h", product, issued: 1, v: 1 })), LICENSE_CONTEXT, KEY.privateKey);

function bundle() {
  const manifest = {
    id: "hello",
    version: "1.0.0",
    product: "inkledger.hello",
    entry: "index.js",
    hostApi: { min: 1, max: 1 },
    slots: ["sidebar-footer"],
    name: { en: "Hello", it: "Ciao" },
    files: { "index.js": sha256hex(Buffer.from(ENTRY)) },
  };
  return JSON.stringify({ format: "seal-bundle-v1", manifest, signature: signManifest(manifest, PACKAGE_CONTEXT, KEY.privateKey), files: { "index.js": Buffer.from(ENTRY).toString("base64") } });
}

const item = (id: string) => ({
  id,
  product: "inkledger." + id,
  version: "1.0.0",
  hostApi: { min: 1, max: 1 },
  name: { en: id, it: id },
  tagline: { en: "t", it: "t" },
  mode: "request",
  price: { amount: 2.99, currency: "EUR" },
  methods: { card: true, bitcoin: "soon" },
});

const worker = { requestStatus: { status: "pending" } as Record<string, unknown> };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => (await import("../queries/connection")).q<T>(text, ...params);

/** A caller for the account as it is now (a request reads its row afresh: grants given since count). */
async function callerOf(id: number): Promise<Caller> {
  const { userById } = await import("../queries/accounts");
  const { appRouter } = await import("../router");
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: (await userById(id)) ?? null, sessionId: null });
}

let n = 0;
/** A member holding exactly these permissions and module grants. */
async function member(permissions: Permission[], modules: string[] = []): Promise<{ id: number; caller: Caller }> {
  const [row] = await q<{ id: number }>(
    "INSERT INTO users (username, display_name, role, permissions, module_grants, created_at) VALUES (?, 'Someone', 'member', ?, ?, 1) RETURNING id",
    "perm" + ++n,
    JSON.stringify(permissions),
    JSON.stringify(modules),
  );
  return { id: row.id, caller: await callerOf(row.id) };
}

const grantsOf = async (id: number) => JSON.parse((await q<{ module_grants: string }>("SELECT module_grants FROM users WHERE id = ?", id))[0].module_grants) as string[];
async function events(action: string) {
  const { flushAudit } = await import("../lib/audit");
  await flushAudit();
  return q<{ actor_user_id: number | null; target_id: string | null; after: string | null; outcome: string }>("SELECT actor_user_id, target_id, after, outcome FROM audit_events WHERE action = ? ORDER BY id", action);
}

const forbidden = { code: "FORBIDDEN" };

describe("the Store by permission", () => {
  let manager: { id: number; caller: Caller };
  let granted: { id: number; caller: Caller };
  let buyer: { id: number; caller: Caller };
  let other: { id: number; caller: Caller };

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== "https://store.test") return new Response("{}", { status: 500 });
      if (url.pathname === "/catalog") return json({ v: 1, items: [item("hello"), item("svg")] });
      if (url.pathname === "/request") return json({ token: "t".repeat(43) });
      if (url.pathname === `/request/${"t".repeat(43)}`) return json(worker.requestStatus);
      if (url.pathname === "/checkout") return json({ token: "c".repeat(43), url: "https://shop.test/buy" });
      if (url.pathname === "/claim-paid") {
        const { code } = JSON.parse(String(init?.body)) as { code: string };
        return code === "PAID-HELLO" ? json({ license: license("inkledger.hello"), product: "inkledger.hello" }) : json({ error: "code" }, 404);
      }
      if (url.pathname === "/download/inkledger.hello" || url.pathname === "/bundle/inkledger.hello") return new Response(bundle());
      return json({ error: "nope" }, 404);
    });
    await (await import("../queries/connection")).resetDbForTests();
    manager = await member(["manageStore"]);
    granted = await member(["useModules"], ["hello"]);
    buyer = await member(["acquireModules", "useModules"]);
    other = await member(["acquireModules", "useModules"]);
  });

  it("someone with a module granted, no more, is refused the catalogue and getting modules", async () => {
    await expect(granted.caller.store.catalog()).rejects.toMatchObject(forbidden);
    await expect(granted.caller.store.pending()).rejects.toMatchObject(forbidden);
    await expect(granted.caller.store.requestLicense({ product: "inkledger.hello", email: "g@example.com" })).rejects.toMatchObject(forbidden);
    await expect(granted.caller.store.checkout({ product: "inkledger.hello", method: "card" })).rejects.toMatchObject(forbidden);
    await expect(granted.caller.store.claimPaid({ product: "inkledger.hello", code: "PAID-HELLO" })).rejects.toMatchObject(forbidden);
    await expect(granted.caller.store.dismiss({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
    expect((await events("store.requestLicense")).map((e) => e.outcome)).toEqual(["denied"]);
  });

  it("acquireModules browses and requests; the module lands granted to the requester only, whoever polls", async () => {
    expect((await buyer.caller.store.catalog()).entries.map((e) => e.id)).toEqual(["hello", "svg"]);
    await buyer.caller.store.requestLicense({ product: "inkledger.hello", email: "b@example.com" });
    // Someone else can't take it over, see it, or dismiss it.
    await expect(other.caller.store.requestLicense({ product: "inkledger.hello", email: "o@example.com" })).rejects.toMatchObject(forbidden);
    await expect(other.caller.store.checkout({ product: "inkledger.hello", method: "card" })).rejects.toMatchObject(forbidden);
    await expect(other.caller.store.dismiss({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
    expect((await other.caller.store.catalog()).entries[0].pending).toBeNull();
    expect((await buyer.caller.store.catalog()).entries[0].pending).toMatchObject({ status: "pending" });
    // A Store manager sees every pending entry.
    expect((await manager.caller.store.pending()).pending).toEqual([{ product: "inkledger.hello", kind: "request", status: "pending" }]);

    worker.requestStatus = { status: "approved", license: license("inkledger.hello") };
    expect(await other.caller.store.pending()).toEqual({ pending: [], installed: [] });
    expect(await grantsOf(buyer.id)).toEqual(["hello"]);
    expect(await grantsOf(other.id)).toEqual([]);
    expect(await grantsOf(manager.id)).toEqual([]);
    expect((await events("store.grantAcquired")).map((e) => [e.target_id, JSON.parse(e.after ?? "{}") as unknown])).toEqual([[String(buyer.id), { product: "inkledger.hello", moduleId: "hello", userId: buyer.id }]]);
    // Now on the server: acquiring it again would only grant it, which is Settings › Users' to do.
    await expect(other.caller.store.requestLicense({ product: "inkledger.hello", email: "o@example.com" })).rejects.toMatchObject(forbidden);
    // A purchase someone else didn't start here can't be claimed.
    await expect(other.caller.store.claimPaid({ product: "inkledger.hello", code: "PAID-HELLO" })).rejects.toMatchObject(forbidden);
  });

  it("a granted module is turned off and on and set up by its user, and only that one; changes are audited", async () => {
    for (const id of [granted.id, buyer.id]) {
      const c = await callerOf(id);
      await expect(c.modules.setEnabled({ id: "hello", enabled: false })).resolves.toEqual({ enabled: false });
      await expect(c.modules.setEnabled({ id: "hello", enabled: true })).resolves.toEqual({ enabled: true });
      await c.modules.storageSet({ moduleId: "hello", key: "city", value: "Rome", from: "settings" });
      await expect(c.modules.storageGet({ moduleId: "hello", key: "city" })).resolves.toMatchObject({ value: "Rome" });
    }
    await expect(other.caller.modules.setEnabled({ id: "hello", enabled: false })).rejects.toMatchObject(forbidden);
    await expect(other.caller.modules.storageSet({ moduleId: "hello", key: "city", value: "x", from: "settings" })).rejects.toMatchObject(forbidden);
    const toggles = await events("modules.setEnabled");
    expect(toggles.filter((e) => e.actor_user_id === granted.id).map((e) => [e.outcome, JSON.parse(e.after ?? "{}") as unknown])).toEqual([
      ["ok", { id: "hello", enabled: false }],
      ["ok", { id: "hello", enabled: true }],
    ]);
    const configured = await events("modules.configure");
    expect(configured.map((e) => [e.actor_user_id, JSON.parse(e.after ?? "{}") as unknown])).toEqual([
      [granted.id, { id: "hello", key: "city" }],
      [buyer.id, { id: "hello", key: "city" }],
    ]);
    // What the module writes as it runs (not from its settings) is no event.
    await granted.caller.modules.storageSet({ moduleId: "hello", key: "progress", value: 1 });
    expect(await events("modules.configure")).toHaveLength(2);
  });

  it("someone with modules but none granted sees no installed module", async () => {
    const none = await member(["useModules"]);
    expect((await none.caller.modules.list()).modules).toEqual([]);
    expect((await manager.caller.modules.list()).modules.map((m) => m.id)).toEqual(["hello"]);
  });

  it("licences, installs and removal stay with manageStore; the module list hides licences from others", async () => {
    for (const id of [granted.id, buyer.id]) {
      const who = { caller: await callerOf(id) };
      const list = await who.caller.modules.list();
      expect(list.granted).toEqual(["hello"]);
      expect(list.licenses).toEqual([]);
      // Only theirs: here every installed module is granted to both (hello).
      expect(list.modules.map((m) => m.id)).toEqual(["hello"]);
      expect(list.extraKey).toBe(false);
      await expect(who.caller.store.install({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
      await expect(who.caller.store.restoreLicense({ text: "x" })).rejects.toMatchObject(forbidden);
      await expect(who.caller.modules.exportLicense({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
      await expect(who.caller.modules.activation({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
      await expect(who.caller.modules.removeLicense({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
      await expect(who.caller.modules.uninstall({ id: "hello" })).rejects.toMatchObject(forbidden);
    }
    const list = await manager.caller.modules.list();
    expect(list.licenses.map((l) => l.product)).toEqual(["inkledger.hello"]);
    expect(list.extraKey).toBe(true);
    await expect(manager.caller.modules.exportLicense({ product: "inkledger.hello" })).resolves.toMatchObject({ product: "inkledger.hello" });
    await expect(manager.caller.store.install({ product: "inkledger.hello" })).resolves.toMatchObject({ id: "hello" });
  });

  it("a paid module: the buyer claims their own purchase and gets it; a manager's purchase grants nobody", async () => {
    await manager.caller.modules.removeLicense({ product: "inkledger.hello" });
    await manager.caller.modules.uninstall({ id: "hello" });
    await other.caller.store.checkout({ product: "inkledger.hello", method: "card" });
    await expect(buyer.caller.store.claimPaid({ product: "inkledger.hello", code: "PAID-HELLO" })).rejects.toMatchObject(forbidden);
    await expect(other.caller.store.claimPaid({ product: "inkledger.hello", code: "PAID-HELLO" })).resolves.toEqual({ ok: true });
    expect(await grantsOf(other.id)).toEqual(["hello"]);

    await manager.caller.modules.removeLicense({ product: "inkledger.hello" });
    await manager.caller.store.checkout({ product: "inkledger.hello", method: "card" });
    await expect(manager.caller.store.claimPaid({ product: "inkledger.hello", code: "PAID-HELLO" })).resolves.toEqual({ ok: true });
    expect(await grantsOf(manager.id)).toEqual([]);
    expect((await events("store.grantAcquired")).map((e) => e.target_id)).toEqual([String(buyer.id), String(other.id)]);
  });
});
