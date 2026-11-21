import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) =>
    String(file).endsWith("index.html") ? "<!doctype html><html><head></head><body></body></html>" : (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});
vi.mock("../ssr", () => ({ renderSSR: async () => null }));

describe("the built app's files", () => {
  it("a missing hashed asset is a 404, never the app shell cached for a year", async () => {
    const { serveStaticFiles } = await import("./vite");
    const app = new Hono();
    serveStaticFiles(app as never);
    const res = await app.request("/assets/gone-0123abcd.js", { headers: { accept: "text/html,*/*" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control") ?? "").not.toMatch(/immutable/);
    // Any other route still gets the app shell, not cached.
    const page = await app.request("/settings/users", { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-cache");
  });
});
