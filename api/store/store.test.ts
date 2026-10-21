import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-store-"));
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

const SITE = "https://acme.atlassian.net";
const ENTRY = "export default { id: 'hello', hostApi: 1, mount: {} };\n";

const license = (product: string) =>
  signEnvelope(Buffer.from(JSON.stringify({ id: "R-1", email_hash: "h", product, issued: 1, v: 1 })), LICENSE_CONTEXT, KEY.privateKey);

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
  return JSON.stringify({
    format: "seal-bundle-v1",
    manifest,
    signature: signManifest(manifest, PACKAGE_CONTEXT, KEY.privateKey),
    files: { "index.js": Buffer.from(ENTRY).toString("base64") },
  });
}

const item = (over: Record<string, unknown> = {}) => ({
  id: "hello",
  product: "inkledger.hello",
  version: "1.0.0",
  hostApi: { min: 1, max: 1 },
  name: { en: "Hello", it: "Ciao" },
  tagline: { en: "Says hello", it: "Saluta" },
  mode: "request",
  price: { amount: 2.99, currency: "EUR" },
  methods: { card: true, bitcoin: "soon" },
  ...over,
});

/** The Worker, as far as this server sees it. */
const worker = {
  items: [item({
    image: "https://img.test/hello.webp",
    hero: "https://img.test/hero.webp",
    gallery: [{ src: "https://img.test/g0.webp", caption: { en: "One", it: "Uno" } }],
    highlights: [{ icon: "unknown-icon", title: { en: "T", it: "T" }, body: { en: "B", it: "B" } }],
  }), item({ id: "svg", product: "inkledger.svg", image: "https://img.test/x.svg" }), item({ id: "future", product: "inkledger.future", hostApi: { min: 2, max: 2 }, mode: "warp" }), { id: "broken" }] as unknown[],
  requestStatus: { status: "pending" } as Record<string, unknown>,
  calls: [] as { path: string; body?: unknown }[],
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("module store", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let app: typeof import("../boot").default;
  let cookie = "";

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/rest/api/3/myself")) return json({ accountId: "acc-1", displayName: "Mario" });
      if (url.origin === "https://img.test") {
        const svg = url.pathname.endsWith(".svg");
        return new Response(svg ? "<svg onload='alert(1)'/>" : "RIFF", { headers: { "content-type": svg ? "image/svg+xml" : "image/webp" } });
      }
      if (url.origin !== "https://store.test") return new Response("{}", { status: 500 });
      worker.calls.push({ path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname === "/catalog") return json({ v: 1, items: worker.items });
      if (url.pathname === "/request") {
        const b = JSON.parse(String(init?.body)) as { email: string };
        return b.email.endsWith("@spam.test") ? json({ error: "rate" }, 429) : json({ token: "t".repeat(43) });
      }
      if (url.pathname === `/request/${"t".repeat(43)}`) return json(worker.requestStatus);
      if (url.pathname === "/checkout") return json({ token: "c".repeat(43), url: "https://shop.test/buy?claim=c" });
      if (url.pathname === `/claim/${"c".repeat(43)}`) return json({ error: "unknown" }, 404);
      if (url.pathname === "/download/inkledger.hello") return new Response(bundle());
      if (url.pathname === "/bundle/inkledger.hello") return new Response(bundle());
      return json({ error: "nope" }, 404);
    });
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    app = (await import("../boot")).default;
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });

  beforeEach(() => {
    worker.calls = [];
  });

  it("lists the catalog with local state; bad items drop, unknown modes show as soon", async () => {
    const { enabled, entries } = await caller.store.catalog();
    expect(enabled).toBe(true);
    expect(entries.map((e) => e.id)).toEqual(["hello", "svg", "future"]);
    expect(entries[0]).toMatchObject({ mode: "request", installed: null, licensed: false, supported: true, pending: null });
    expect(entries[2]).toMatchObject({ mode: "soon", supported: false });
    // Pictures come through this server (CSP img-src 'self'), raster only.
    expect(entries[0].image).toBe("/api/store/media/hello/image");
    expect(entries[0].gallery?.map((g) => g.src)).toEqual(["/api/store/media/hello/0"]);
    expect((await app.request("/api/store/media/hello/image")).status).toBe(401);
    for (const slot of ["image", "hero", "0"]) {
      const img = await app.request(`/api/store/media/hello/${slot}`, { headers: { cookie } });
      expect([img.status, img.headers.get("content-type"), await img.text()]).toEqual([200, "image/webp", "RIFF"]);
    }
    expect((await app.request("/api/store/media/hello/1", { headers: { cookie } })).status).toBe(404);
    expect((await app.request("/api/store/media/svg/image", { headers: { cookie } })).status).toBe(404);
  });

  it("a licence request waits, then installs the module by itself once approved", async () => {
    await expect(caller.store.requestLicense({ product: "inkledger.hello", email: "x@spam.test" })).rejects.toThrow(/Too many/);
    await caller.store.requestLicense({ product: "inkledger.hello", email: "fan@example.com", message: "hi", locale: "it" });
    expect(worker.calls.at(-1)?.body).toEqual({ product: "inkledger.hello", email: "fan@example.com", message: "hi", locale: "it" });

    expect(await caller.store.pending()).toEqual({ pending: [{ product: "inkledger.hello", kind: "request", status: "pending" }], installed: [] });
    // The token stays on the server.
    expect(JSON.stringify(await caller.store.catalog())).not.toContain("t".repeat(43));

    worker.requestStatus = { status: "approved", license: license("inkledger.hello") };
    expect(await caller.store.pending()).toEqual({ pending: [], installed: ["inkledger.hello"] });
    const [m] = (await caller.modules.list()).modules;
    expect(m).toMatchObject({ id: "hello", status: { state: "active" } });
    expect((await caller.store.catalog()).entries[0]).toMatchObject({ installed: { state: "active" }, licensed: true, pending: null });
  });

  it("a module removed by hand comes back from its stored licence", async () => {
    expect((await caller.store.catalog()).entries[0].highlights?.[0].icon).toBe("sparkles");
    await caller.modules.uninstall({ id: "hello" });
    expect((await caller.store.catalog()).entries[0]).toMatchObject({ installed: null, installedVersion: null, licensed: true });
    expect(await caller.store.install({ product: "inkledger.hello" })).toEqual({ id: "hello", version: "1.0.0" });
    expect(worker.calls.at(-1)).toMatchObject({ path: "/bundle/inkledger.hello", body: { license: expect.any(String) } });
    expect((await caller.store.catalog()).entries[0]).toMatchObject({ installed: { state: "active" }, installedVersion: "1.0.0", outdated: false });
    await expect(caller.store.install({ product: "inkledger.future" })).rejects.toThrow(/No licence/);
  });

  it("the catalog is asked once per 12 hours, survives a restart, and a stale copy covers an outage", async () => {
    const { fetchCatalog, forgetCatalog, CATALOG_TTL_MS } = await import("./client");
    await forgetCatalog();
    const t0 = Date.now();
    await fetchCatalog(t0);
    const asked = () => worker.calls.filter((c) => c.path === "/catalog").length;
    const before = asked();
    await fetchCatalog(t0 + CATALOG_TTL_MS - 1);
    expect(asked()).toBe(before);
    // Expired and the Worker down: the last copy.
    const items = worker.items;
    worker.items = "broken" as unknown as unknown[];
    expect((await fetchCatalog(t0 + CATALOG_TTL_MS + 1)).length).toBeGreaterThan(0);
    worker.items = items;
    await forgetCatalog();
  });

  it("a licence goes out as a file and comes back on a restore; junk is refused", async () => {
    const file = await caller.modules.exportLicense({ product: "inkledger.hello" });
    expect(file).toMatchObject({ format: "inkledger-license-v1", product: "inkledger.hello", license: expect.any(String) });
    // The test key is trusted through MODULES_TRUST_EXTRA_KEY.
    expect((await caller.modules.list()).licenses[0]).toMatchObject({ product: "inkledger.hello", issuer: "dev" });
    await caller.modules.removeLicense({ product: "inkledger.hello" });
    expect((await caller.modules.list()).licenses).toEqual([]);
    expect(await caller.store.restoreLicense({ text: JSON.stringify(file) })).toEqual({ product: "inkledger.hello", activation: "not-required" });
    await caller.modules.removeLicense({ product: "inkledger.hello" });
    expect(await caller.store.restoreLicense({ text: file.license })).toEqual({ product: "inkledger.hello", activation: "not-required" });
    await expect(caller.store.restoreLicense({ text: '{"format":"inkledger-license-v1","license":"forged.sig"}' })).rejects.toThrow(/not a valid/);
    await expect(caller.modules.exportLicense({ product: "inkledger.none" })).rejects.toThrow();
  });

  it("an older installed version is offered as an update", async () => {
    worker.items = [item({ version: "1.1.0" })];
    const { forgetCatalog } = await import("./client");
    await forgetCatalog();
    expect((await caller.store.catalog()).entries[0]).toMatchObject({ installedVersion: "1.0.0", outdated: true });
  });

  it("a declined request is shown until dismissed", async () => {
    worker.requestStatus = { status: "declined" };
    await caller.store.requestLicense({ product: "inkledger.hello", email: "fan@example.com" });
    expect((await caller.store.pending()).pending).toEqual([{ product: "inkledger.hello", kind: "request", status: "declined" }]);
    await caller.store.dismiss({ product: "inkledger.hello" });
    expect((await caller.store.pending()).pending).toEqual([]);
  });

  it("a checkout returns the payment page; one the Worker forgot is dropped", async () => {
    expect(await caller.store.checkout({ product: "inkledger.hello", method: "card" })).toEqual({ url: "https://shop.test/buy?claim=c" });
    expect(worker.calls.at(-1)?.body).toEqual({ product: "inkledger.hello", method: "card" });
    expect(await caller.store.pending()).toEqual({ pending: [], installed: [] });
  });
});

