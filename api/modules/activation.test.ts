import { describe, it, expect, beforeAll, vi } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = ":memory:";
process.env.STORE_URL = "https://store.test";
const STORE = generateKeyPairSync("ed25519");
process.env.TEST_ACTIVATION_KEY = STORE.publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.TEST_ACTIVATION_REQUIRED = "1";
delete process.env.MODULES_TRUST_EXTRA_KEY;
const dir = mkdtempSync(join(tmpdir(), "ikl-instance-"));
process.env.INSTANCE_KEY_PATH = join(dir, "instance.key");

import { signEnvelope } from "../vendor/seal/envelope";

const DAY = 86_400_000;
/** The store Worker as WP-18 answers: a slot limit, proofs checked, tokens signed. */
const worker = {
  limit: 2,
  slots: new Map<string, Set<string>>(),
  mode: "ok" as "ok" | "down",
  calls: [] as string[],
  exp: 0,
};
const token = (lic: string, product: string, inst: string, iat: number, exp: number) =>
  signEnvelope(Buffer.from(JSON.stringify({ lic, product, inst, iat, exp, v: 1 })), "inkledger-activation-v1\n", STORE.privateKey);

vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  worker.calls.push(url.pathname);
  if (worker.mode === "down") return new Response("{}", { status: 503 });
  if (url.pathname === "/nonce") return Response.json({ nonce: "n-1", exp: Date.now() + 300_000 });
  const b = JSON.parse(String(init?.body ?? "{}")) as { license: string; instanceId: string; pubkey: string; nonce: string; sig: string };
  const lic = b.license.split(":")[0];
  const product = b.license.split(":")[1];
  if (url.pathname === "/activate" || url.pathname === "/deactivate") {
    const action = url.pathname.slice(1);
    // Proof of possession: the instance key signed the challenge.
    const raw = Buffer.from(b.pubkey, "base64url");
    const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    const ok = verify(null, Buffer.from(`inkledger-activate-v1\n${action}\n${b.nonce}\n${b.instanceId}\n${lic}`), spki, Buffer.from(b.sig, "base64url"));
    if (!ok) return Response.json({ error: "proof" }, { status: 403 });
    const slots = worker.slots.get(lic) ?? new Set();
    worker.slots.set(lic, slots);
    if (action === "deactivate") {
      slots.delete(b.instanceId);
      return Response.json({ ok: true, active: slots.size });
    }
    if (!slots.has(b.instanceId) && slots.size >= worker.limit) return Response.json({ error: "limit" }, { status: 403 });
    slots.add(b.instanceId);
    const iat = Date.now();
    const exp = worker.exp || iat + 90 * DAY;
    return Response.json({ token: token(lic, product, b.instanceId, iat, exp), exp, active: slots.size, limit: worker.limit });
  }
  if (url.pathname === "/activations") return Response.json({ limit: worker.limit, active: [...(worker.slots.get(lic) ?? [])].map((instanceId) => ({ instanceId, iat: 1, exp: 2 })) });
  return new Response("{}", { status: 404 });
});

/** Licences here are plain "id:product" texts: activation.ts never reads them, the store does. */
const LIC = { id: "L-1", product: "inkledger.hello", text: "L-1:inkledger.hello" };

describe("module licences active per server (WP-19)", () => {
  type Act = typeof import("./activation");
  let a: Act;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    a = await import("./activation");
  });

  it("this server's key is made once, 0600, and its id is what the store counts", async () => {
    const { instance } = await import("./instance");
    const me = instance();
    expect(me.id).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(process.env.INSTANCE_KEY_PATH!).mode & 0o777).toBe(0o600);
    expect(instance().id).toBe(me.id);
  });

  it("missing until activated; activated, the token is this server's; a token for another server is refused", async () => {
    expect((await a.activationStates([LIC])).get("L-1")).toEqual({ state: "missing" });
    const r = await a.activate(LIC.text, LIC.id);
    expect(r).toMatchObject({ ok: true, active: 1, limit: 2 });
    a.forgetActivations();
    expect((await a.activationStates([LIC])).get("L-1")).toMatchObject({ state: "active" });
    const other = token("L-1", LIC.product, "f".repeat(32), Date.now(), Date.now() + DAY);
    expect(await a.acceptToken(other, "L-1", LIC.product)).toBe(false);
  });

  it("over the limit: refused plainly, and the server holds nothing", async () => {
    worker.slots.set("L-2", new Set(["a".repeat(32), "b".repeat(32)]));
    const L2 = { id: "L-2", product: "inkledger.hello", text: "L-2:inkledger.hello" };
    expect(await a.activate(L2.text, L2.id)).toEqual({ ok: false, reason: "limit" });
    expect((await a.activationStates([L2])).get("L-2")).toEqual({ state: "missing" });
    // Another server frees its slot: this one gets it.
    worker.slots.get("L-2")!.delete("a".repeat(32));
    expect(await a.activate(L2.text, L2.id)).toMatchObject({ ok: true });
  });

  it("renewed when less than 30 days are left; the store unreachable, a grace of 30 days", async () => {
    const now = Date.now();
    worker.calls = [];
    expect(await a.renewActivations([LIC], now)).toEqual([]);
    expect(worker.calls).toEqual([]);
    // 80 days on: renewed.
    const later = now + 80 * DAY;
    const done = await a.renewActivations([LIC], later);
    expect(done.map((d) => d.result.ok)).toEqual([true]);
    // The token ends, the store is down: still on, for a while.
    worker.exp = Date.now() + 1000;
    await a.activate(LIC.text, LIC.id);
    worker.mode = "down";
    try {
      const end = Date.now() + 2 * DAY;
      expect((await a.renewActivations([LIC], end))[0].result).toEqual({ ok: false, reason: "unreachable" });
      a.forgetActivations();
      expect((await a.activationStates([LIC], end)).get("L-1")).toMatchObject({ state: "grace" });
      a.forgetActivations();
      expect((await a.activationStates([LIC], end + 40 * DAY)).get("L-1")).toEqual({ state: "missing" });
    } finally {
      worker.mode = "ok";
      worker.exp = 0;
    }
  });

  it("a grace comes only from this server's own token, ends with it, and is never made anew", async () => {
    const L3 = { id: "L-3", product: "inkledger.hello", text: "L-3:inkledger.hello" };
    worker.mode = "down";
    try {
      // Never activated here: the store out of reach starts no grace (else a blocked store would mean no activation, ever).
      expect(await a.activate(L3.text, L3.id)).toEqual({ ok: false, reason: "unreachable" });
      a.forgetActivations();
      expect((await a.activationStates([L3])).get("L-3")).toEqual({ state: "missing" });
    } finally {
      worker.mode = "ok";
    }
    // Activated with a short token, then the store goes down for good.
    worker.exp = Date.now() + 1000;
    await a.activate(L3.text, L3.id);
    worker.exp = 0;
    worker.mode = "down";
    try {
      const t1 = Date.now() + 2 * DAY;
      await a.activate(L3.text, L3.id, t1);
      a.forgetActivations();
      const g = (await a.activationStates([L3], t1)).get("L-3");
      expect(g).toMatchObject({ state: "grace" });
      // The grace ran out; the next try, still unreachable, doesn't start another one.
      const t2 = t1 + 40 * DAY;
      await a.activate(L3.text, L3.id, t2);
      a.forgetActivations();
      expect((await a.activationStates([L3], t2)).get("L-3")).toEqual({ state: "missing" });
    } finally {
      worker.mode = "ok";
    }
  });

  it("deactivated: the slot goes back; offline: the code is signed for this server, its token accepted", async () => {
    await a.activate(LIC.text, LIC.id);
    await a.deactivate(LIC.text, LIC.id);
    expect((await a.activationsOf(LIC.text)).active).toEqual([]);
    a.forgetActivations();
    expect((await a.activationStates([LIC])).get("L-1")).toEqual({ state: "missing" });
    const code = JSON.parse(Buffer.from(a.offlineCode("L-1"), "base64url").toString()) as { instanceId: string; nonce: string };
    expect(code.nonce).toMatch(/^offline:\d+$/);
    expect(await a.acceptToken(token("L-1", LIC.product, code.instanceId, Date.now(), Date.now() + 90 * DAY), "L-1", LIC.product)).toBe(true);
    a.forgetActivations();
    expect((await a.activationStates([LIC])).get("L-1")).toMatchObject({ state: "active" });
  });
});
