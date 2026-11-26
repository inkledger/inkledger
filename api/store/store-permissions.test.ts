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
 * Who does what in the Store (contracts/accounts.ts, docs/it/who-pays.md): useModules sees
 * only the modules it holds a licence of (to switch and set up) or that were offered to it or
 * its team (to buy for itself); acquireModules, the whole catalogue for itself; manageStore
 * offers, assigns (one licence per person, paid by the admin or a team), moves and removes.
 */

const ENTRY = "export default { id: 'hello', hostApi: 1, mount: {} };\n";
/** A licence with its own id: one purchase, one licence. */
const license = (product: string, id: string) =>
  signEnvelope(Buffer.from(JSON.stringify({ id, email_hash: "h", product, issued: 1, v: 1 })), LICENSE_CONTEXT, KEY.privateKey);

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

/** The Worker: each request its own token (and, approved, its own licence); a code per paid order. */
const worker = { tokens: new Map<string, { product: string; email: string }>(), approved: new Set<string>(), requests: [] as { product: string; email: string }[] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const approveAll = () => worker.tokens.forEach((_, token) => worker.approved.add(token));

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => (await import("../queries/connection")).q<T>(text, ...params);

/** A caller for the account as it is now (a request reads its row afresh: grants given since count). */
async function as(id: number): Promise<Caller> {
  const { userById } = await import("../queries/accounts");
  const { appRouter } = await import("../router");
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: (await userById(id)) ?? null, sessionId: null });
}

let n = 0;
/** A member holding exactly these permissions and module grants. */
async function member(permissions: Permission[], modules: string[] = []): Promise<number> {
  const [row] = await q<{ id: number }>(
    "INSERT INTO users (username, display_name, role, permissions, module_grants, email, created_at) VALUES (?, ?, 'member', ?, ?, ?, 1) RETURNING id",
    "perm" + ++n,
    "Person " + n,
    JSON.stringify(permissions),
    JSON.stringify(modules),
    `p${n}@example.com`,
  );
  return row.id;
}

const grantsOf = async (id: number) => JSON.parse((await q<{ module_grants: string }>("SELECT module_grants FROM users WHERE id = ?", id))[0].module_grants) as string[];
const ledger = (product: string) => q<{ holder_user_id: number | null; payer_kind: string; payer_id: number | null; bought_by: number | null }>("SELECT holder_user_id, payer_kind, payer_id, bought_by FROM module_licences WHERE product = ? ORDER BY holder_user_id", product);
async function events(action: string) {
  const { flushAudit } = await import("../lib/audit");
  await flushAudit();
  return q<{ actor_user_id: number | null; target_id: string | null; after: string | null; outcome: string }>("SELECT actor_user_id, target_id, after, outcome FROM audit_events WHERE action = ? ORDER BY id", action);
}

const forbidden = { code: "FORBIDDEN" };

describe("the Store by permission: offers, per-person licences, assignments", () => {
  let manager: number;
  let ugo: number; // a member: useModules only
  let ann: number; // in the team
  let cy: number; // in the team
  let bob: number; // not in the team
  let whole: number; // acquireModules: the whole catalogue for themselves
  let team: number;

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== "https://store.test") return new Response("{}", { status: 500 });
      if (url.pathname === "/catalog") return json({ v: 1, items: [item("hello"), item("svg"), item("other")] });
      if (url.pathname === "/request") {
        const b = JSON.parse(String(init?.body)) as { product: string; email: string };
        worker.requests.push(b);
        const token = ("t" + worker.tokens.size).padEnd(43, "x");
        worker.tokens.set(token, b);
        return json({ token });
      }
      const status = /^\/request\/(.+)$/.exec(url.pathname);
      if (status) {
        const r = worker.tokens.get(status[1]);
        return json(r && worker.approved.has(status[1]) ? { status: "approved", license: license(r.product, "L-" + status[1].slice(0, 6)) } : { status: "pending" });
      }
      if (url.pathname === "/checkout") return json({ token: ("c" + Math.random().toString(36).slice(2)).padEnd(43, "c"), url: "https://shop.test/buy" });
      if (url.pathname === "/claim-paid") {
        const { code } = JSON.parse(String(init?.body)) as { code: string };
        return code.startsWith("PAID-") ? json({ license: license("inkledger.hello", "P-" + code), product: "inkledger.hello" }) : json({ error: "code" }, 404);
      }
      if (url.pathname === "/download/inkledger.hello" || url.pathname === "/bundle/inkledger.hello") return new Response(bundle());
      return json({ error: "nope" }, 404);
    });
    await (await import("../queries/connection")).resetDbForTests();
    manager = await member(["manageStore", "useModules"]);
    ugo = await member(["useModules"]);
    ann = await member(["useModules"]);
    cy = await member(["useModules"]);
    bob = await member(["useModules"]);
    whole = await member(["acquireModules"]);
    [{ id: team }] = await q<{ id: number }>("INSERT INTO teams (name, created_at) VALUES ('Design', 1) RETURNING id");
    for (const id of [ann, cy]) await q("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')", team, id);
  });

  it("a member with nothing offered or held sees no module and can't get one", async () => {
    const c = await as(ugo);
    await expect(c.store.catalog()).rejects.toMatchObject(forbidden);
    await expect(c.store.requestLicense({ product: "inkledger.hello", email: "u@example.com" })).rejects.toMatchObject(forbidden);
    await expect(c.store.checkout({ product: "inkledger.hello", method: "card" })).rejects.toMatchObject(forbidden);
    expect((await c.modules.list()).modules).toEqual([]);
    // Nor manages anything of the Store.
    await expect(c.store.offer({ product: "inkledger.hello", userId: ugo })).rejects.toMatchObject(forbidden);
    await expect(c.store.assign({ product: "inkledger.hello", kind: "request", people: [{ userId: ugo, email: "u@example.com" }] })).rejects.toMatchObject(forbidden);
    // Past the gate (useModules), refused for the product: recorded as failed.
    expect((await events("store.requestLicense")).map((e) => e.outcome)).toEqual(["failed"]);
    expect((await events("store.offer")).map((e) => e.outcome)).toEqual(["denied"]);
  });

  it("OFFER to a person: it shows in their Store alone; they request it, the licence is theirs (they pay, they manage it)", async () => {
    await (await as(manager)).store.offer({ product: "inkledger.hello", userId: ugo });
    const c = await as(ugo);
    expect((await c.store.catalog()).entries.map((e) => e.id)).toEqual(["hello"]);
    expect((await c.modules.list()).offers).toEqual(["inkledger.hello"]);
    await expect(c.store.requestLicense({ product: "inkledger.svg", email: "u@example.com" })).rejects.toMatchObject(forbidden);
    await c.store.requestLicense({ product: "inkledger.hello", email: "ugo@example.com" });
    // Others don't see it waiting.
    expect((await (await as(bob)).store.pending().catch(() => ({ pending: [] }))).pending).toEqual([]);
    approveAll();
    expect(await c.store.pending()).toEqual({ pending: [], installed: ["inkledger.hello"] });
    expect(await ledger("inkledger.hello")).toEqual([{ holder_user_id: ugo, payer_kind: "user", payer_id: ugo, bought_by: ugo }]);
    expect(await grantsOf(ugo)).toEqual(["hello"]);
    await expect((await as(ugo)).store.myLicence({ product: "inkledger.hello" })).resolves.toMatchObject({ product: "inkledger.hello" });
    // One licence per person: never a second.
    await expect((await as(ugo)).store.requestLicense({ product: "inkledger.hello", email: "ugo@example.com" })).rejects.toMatchObject(forbidden);
    // Bought by its holder: an admin can't move it.
    const [own] = await q<{ licence_id: string }>("SELECT licence_id FROM module_licences WHERE holder_user_id = ?", ugo);
    await expect((await as(manager)).store.reassign({ licence: own.licence_id, userId: bob })).rejects.toMatchObject(forbidden);
  });

  it("OFFER to a team reaches its members only, as the team is now", async () => {
    const m = await as(manager);
    await m.store.offer({ product: "inkledger.svg", teamId: team });
    expect((await (await as(ann)).store.catalog()).entries.map((e) => e.id)).toEqual(["svg"]);
    await expect((await as(bob)).store.catalog()).rejects.toMatchObject(forbidden);
    await expect((await as(bob)).store.requestLicense({ product: "inkledger.svg", email: "b@example.com" })).rejects.toMatchObject(forbidden);
    // Bob joins: it reaches him; the offer withdrawn: nobody.
    await q("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')", team, bob);
    expect((await (await as(bob)).modules.list()).offers).toEqual(["inkledger.svg"]);
    await q("DELETE FROM team_members WHERE user_id = ?", bob);
    const [offer] = (await m.store.distribution({ product: "inkledger.svg" })).offers;
    await m.store.withdrawOffer({ id: offer.id });
    await expect((await as(ann)).store.catalog()).rejects.toMatchObject(forbidden);
    expect((await events("store.offer")).filter((e) => e.outcome === "ok")).toHaveLength(2);
  });

  it("ASSIGN to a team buys one licence per chosen member, paid by the team: never one shared", async () => {
    const m = await as(manager);
    worker.requests = [];
    const r = await m.store.assign({ product: "inkledger.hello", kind: "request", teamId: team, people: [{ userId: ann, email: "ann@example.com" }, { userId: cy, email: "cy@example.com" }] });
    expect(r).toMatchObject({ started: [{ userId: ann }, { userId: cy }], skipped: [], failed: [] });
    expect(worker.requests.map((x) => x.email)).toEqual(["ann@example.com", "cy@example.com"]);
    // Only the team's members.
    await expect(m.store.assign({ product: "inkledger.hello", kind: "request", teamId: team, people: [{ userId: bob, email: "b@example.com" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // They don't see the admin's purchase as theirs to dismiss.
    await expect((await as(ann)).store.dismiss({ product: "inkledger.hello", for: cy })).rejects.toMatchObject(forbidden);
    approveAll();
    await m.store.pending();
    const rows = await ledger("inkledger.hello");
    expect(rows.filter((x) => x.payer_kind === "team")).toEqual([
      { holder_user_id: ann, payer_kind: "team", payer_id: team, bought_by: manager },
      { holder_user_id: cy, payer_kind: "team", payer_id: team, bought_by: manager },
    ]);
    expect(new Set((await q<{ licence_id: string }>("SELECT licence_id FROM module_licences WHERE product = 'inkledger.hello'")).map((x) => x.licence_id)).size).toBe(3);
    expect(await grantsOf(ann)).toEqual(["hello"]);
    expect(await grantsOf(bob)).toEqual([]);
    // Assigned: they run and set it up, the licence is the buyer side's (no file for them).
    const a = await as(ann);
    await expect(a.modules.setEnabled({ id: "hello", enabled: false })).resolves.toEqual({ enabled: false });
    await a.modules.storageSet({ moduleId: "hello", key: "city", value: "Rome", from: "settings" });
    // Audited: the switch and the setting; what the module writes as it runs is no event.
    await a.modules.storageSet({ moduleId: "hello", key: "progress", value: 1 });
    expect((await events("modules.setEnabled")).filter((e) => e.actor_user_id === ann).map((e) => [e.outcome, JSON.parse(e.after ?? "{}") as unknown])).toEqual([["ok", { id: "hello", enabled: false }]]);
    expect((await events("modules.configure")).map((e) => [e.actor_user_id, JSON.parse(e.after ?? "{}") as unknown])).toEqual([[ann, { id: "hello", key: "city" }]]);
    await expect(a.store.myLicence({ product: "inkledger.hello" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Again: whoever holds one is skipped (nobody is charged twice).
    expect(await m.store.assign({ product: "inkledger.hello", kind: "request", teamId: team, people: [{ userId: ann, email: "ann@example.com" }] })).toMatchObject({ started: [], skipped: [ann] });
    expect((await m.store.distribution({ product: "inkledger.hello" })).licences).toHaveLength(3);
  });

  it("reassigning moves a licence (the payer stays), never copies it", async () => {
    const m = await as(manager);
    const [cys] = await q<{ licence_id: string }>("SELECT licence_id FROM module_licences WHERE holder_user_id = ?", cy);
    await m.store.reassign({ licence: cys.licence_id, userId: bob });
    expect(await grantsOf(cy)).toEqual([]);
    expect(await grantsOf(bob)).toEqual(["hello"]);
    expect(await q("SELECT holder_user_id, payer_kind, payer_id FROM module_licences WHERE licence_id = ?", cys.licence_id)).toEqual([{ holder_user_id: bob, payer_kind: "team", payer_id: team }]);
    expect((await m.store.distribution({ product: "inkledger.hello" })).licences).toHaveLength(3);
    // Someone already holding one can't be given a second.
    await expect(m.store.reassign({ licence: cys.licence_id, userId: ann })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // The own licence refused earlier, this move, the second one refused.
    expect((await events("store.reassign")).map((e) => e.outcome)).toEqual(["failed", "ok", "failed"]);
  });

  it("Settings › Users can give a module only from a free licence: one licence, one person", async () => {
    const owner = await q<{ id: number }>("INSERT INTO users (username, display_name, role, permissions, created_at) VALUES ('boss', 'Boss', 'admin', '[]', 1) RETURNING id");
    const c = await as(owner[0].id);
    const dave = await member(["useModules"]);
    // All three licences are held: none free.
    await expect(c.users.setAccess({ id: dave, permissions: ["useModules"], modules: ["hello"] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await grantsOf(dave)).toEqual([]);
    // Taking it from Bob frees his seat, which Dave can then take.
    await c.users.setAccess({ id: bob, permissions: ["useModules"], modules: [] });
    await c.users.setAccess({ id: dave, permissions: ["useModules"], modules: ["hello"] });
    expect(await grantsOf(dave)).toEqual(["hello"]);
    expect((await ledger("inkledger.hello")).filter((x) => x.holder_user_id === dave)).toHaveLength(1);
  });

  it("acquireModules: the whole catalogue, for oneself only; a paid module claimed by its buyer", async () => {
    const w = await as(whole);
    expect((await w.store.catalog()).entries.map((e) => e.id)).toEqual(["hello", "svg", "other"]);
    await w.store.checkout({ product: "inkledger.hello", method: "card" });
    // A purchase someone else started can't be claimed (nor named for someone else).
    await expect((await as(ugo)).store.claimPaid({ product: "inkledger.hello", code: "PAID-1" })).rejects.toMatchObject(forbidden);
    await expect(w.store.claimPaid({ product: "inkledger.hello", code: "PAID-1", for: ugo })).rejects.toMatchObject(forbidden);
    await expect(w.store.claimPaid({ product: "inkledger.hello", code: "PAID-1" })).resolves.toEqual({ ok: true });
    expect((await ledger("inkledger.hello")).filter((x) => x.holder_user_id === whole)).toEqual([{ holder_user_id: whole, payer_kind: "user", payer_id: whole, bought_by: whole }]);
    expect(await grantsOf(whole)).toEqual(["hello"]);
  });

  it("licences, installs and removal stay with manageStore; removing a licence takes its holder's module", async () => {
    const a = await as(ann);
    expect((await a.modules.list()).licenses).toEqual([]);
    await expect(a.store.install({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
    await expect(a.store.restoreLicense({ text: "x" })).rejects.toMatchObject(forbidden);
    await expect(a.modules.exportLicense({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
    await expect(a.modules.removeLicense({ product: "inkledger.hello" })).rejects.toMatchObject(forbidden);
    await expect(a.modules.uninstall({ id: "hello" })).rejects.toMatchObject(forbidden);
    const [anns] = await q<{ licence_id: string }>("SELECT licence_id FROM module_licences WHERE holder_user_id = ?", ann);
    await (await as(manager)).modules.removeLicense({ id: anns.licence_id });
    expect(await grantsOf(ann)).toEqual([]);
    expect(await grantsOf(ugo)).toEqual(["hello"]);
  });

  it("grants from before the ledger take a licence each (backfill), so moving one never copies it", async () => {
    const { addLicense } = await import("../modules/registry");
    await addLicense(license("inkledger.hello", "L-legacy"));
    const eve = await member(["useModules"], ["hello"]);
    const fred = await member(["useModules"]);
    const { backfillSeats } = await import("./seats");
    await backfillSeats();
    await backfillSeats();
    expect(await q("SELECT licence_id FROM module_licences WHERE holder_user_id = ?", eve)).toEqual([{ licence_id: "L-legacy" }]);
    await (await as(manager)).store.reassign({ licence: "L-legacy", userId: fred });
    expect(await grantsOf(eve)).toEqual([]);
    expect(await grantsOf(fred)).toEqual(["hello"]);
  });
});
