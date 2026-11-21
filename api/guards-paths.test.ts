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
  type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let app: App;

  beforeAll(async () => {
    await (await import("./queries/connection")).resetDbForTests();
    app = (await import("./boot")).default as App;
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

  it("a write from another origin is refused, whatever the path looks like", async () => {
    for (const path of spellings("/api/trpc/auth.logout")) {
      const res = await app.request(path, { method: "POST", headers: { host: "localhost", origin: "https://evil.example.com", "content-type": "application/json" }, body: "{}" });
      expect(res.status, `${path}`).toBe(403);
    }
  });
});
