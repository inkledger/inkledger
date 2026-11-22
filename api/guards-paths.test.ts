import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";
process.env.ALLOWED_HOSTS = "localhost";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

/**
 * The guards on /api/* (allowed hosts, same-origin writes) hold for every
 * spelling of a path the router still matches: encoded line terminators,
 * doubled or trailing slashes, a backslash (GHSA-h7mg-cq63-vhpq, GHSA-jpvv-r467-5p4w).
 */
describe("no path spelling gets past the /api guards", () => {
  type App = { request: (path: string, init?: RequestInit, env?: Record<string, unknown>) => Response | Promise<Response> };
  let app: App;

  beforeAll(async () => {
    await (await import("./queries/connection")).resetDbForTests();
    app = (await import("./boot")).default;
  });

  const spellings = (base: string) => [
    base,
    `${base}%0A`,
    `${base}%0D`,
    `${base}%0D%0A`,
    `${base}%E2%80%A8`,
    `${base}/`,
    base.replace("/api/", "/api//"),
    base.replace("/api/", "/api/%0A"),
    base.replace("/api/", "/api\\"),
  ];
  const routes = ["/api/health", "/api/trpc/auth.me", "/api/events", "/api/hooks/1/token", "/api/shared/token", "/api/outlook/me"];

  it("a host not allowed is refused, whatever the path looks like", async () => {
    for (const route of routes)
      for (const path of spellings(route)) {
        const res = await app.request(path, { headers: { host: "evil.example.com" } });
        expect(res.status, `${path}`).toBe(421);
      }
  });

  it("a request line in absolute form (only proxies get those) is refused: it would pick the scheme clientIp trusts", async () => {
    const at = (target: string) => app.request("/api/health", { headers: { host: "localhost" } }, { incoming: { url: target, headers: {} } });
    expect((await at("https://evil.example/api/health")).status).toBe(400);
    expect((await at("http://localhost/api/health")).status).toBe(400);
    expect((await at("/api/health")).status).toBe(200);
  });

  it("a path that doesn't decode is answered, not a server error", async () => {
    const post = (path: string) => app.request(path, { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: "{}" });
    for (const path of ["/api/trpc/%E0%A4%A", "/api/trpc/backup.get%ZZ"]) expect((await post(path)).status, path).toBe(400);
    // It decodes (to "%"): no such procedure.
    expect((await post("/api/trpc/%25")).status).toBe(404);
  });

  it("a write from another origin is refused, whatever the path looks like", async () => {
    for (const path of spellings("/api/trpc/auth.logout")) {
      const res = await app.request(path, { method: "POST", headers: { host: "localhost", origin: "https://evil.example.com", "content-type": "application/json" }, body: "{}" });
      expect(res.status, `${path}`).toBe(403);
    }
  });

  it("a browser request another site started is refused even without an Origin; servers and keys are not browsers", async () => {
    const post = (path: string, headers: Record<string, string>) =>
      app.request(path, { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: "{}" });
    for (const site of ["cross-site", "same-site"]) expect((await post("/api/trpc/auth.logout", { "sec-fetch-site": site })).status, site).toBe(403);
    // A query that writes, opened by another site (a link, an image): refused too.
    expect((await app.request("/api/trpc/auth.me", { headers: { host: "localhost", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    // Our own pages, a typed address, and clients that aren't browsers go on.
    expect((await post("/api/trpc/auth.logout", { "sec-fetch-site": "same-origin" })).status).not.toBe(403);
    expect((await post("/api/trpc/auth.logout", {})).status).not.toBe(403);
    expect((await app.request("/api/trpc/auth.me", { headers: { host: "localhost", "sec-fetch-site": "none" } })).status).not.toBe(403);
    expect((await app.request("/api/trpc/auth.me", { headers: { host: "localhost", "sec-fetch-site": "same-origin" } })).status).not.toBe(403);
    // A webhook or an add-in key: not a cookie, nothing to forge.
    expect((await post("/api/hooks/1/token", { "sec-fetch-site": "cross-site" })).status).not.toBe(403);
    expect((await post("/api/outlook/copy", { "sec-fetch-site": "cross-site", authorization: "Bearer ikl_ol_abcdefghijklmnopqrstuvwxyz" })).status).not.toBe(403);
  });

  it("an opaque origin (a sandboxed module frame: Origin null) can neither write nor open a query", async () => {
    const opaque = { host: "localhost", origin: "null", "content-type": "application/json" };
    for (const path of ["/api/trpc/auth.logout", "/api/modules/upload", "/api/trpc/modules.setEnabled"]) {
      // With Sec-Fetch-Site, as browsers send it from such a frame, and without (older browsers).
      for (const site of [{ "sec-fetch-site": "cross-site" }, {}]) {
        expect((await app.request(path, { method: "POST", headers: { ...opaque, ...site }, body: "{}" })).status, `${path} ${JSON.stringify(site)}`).toBe(403);
      }
    }
    for (const path of ["/api/trpc/auth.me", "/api/trpc/modules.list"]) {
      for (const site of [{ "sec-fetch-site": "cross-site" }, {}]) {
        expect((await app.request(path, { headers: { ...opaque, ...site } })).status, `${path} ${JSON.stringify(site)}`).toBe(403);
      }
    }
  });
});
