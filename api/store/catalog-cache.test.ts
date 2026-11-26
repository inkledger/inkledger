import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";
process.env.STORE_URL = "https://store.example";

const item = { id: "hello", product: "inkledger.hello", version: "1.0.0", hostApi: { min: 1, max: 1 }, name: { en: "Hello", it: "Ciao" }, tagline: { en: "Says hello", it: "Saluta" }, mode: "request", price: { amount: 2.99, currency: "EUR" }, methods: { card: true, bitcoin: "soon" } };
const catalog = { v: 1, items: [item] };

describe("the catalog copy kept between restarts", () => {
  const seen: { inm: string | null }[] = [];
  let mode: "etag" | "plain" | "down" = "etag";
  const stub = () =>
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const inm = new Headers(init?.headers).get("if-none-match");
      seen.push({ inm });
      if (mode === "down") return new Response("x", { status: 503 });
      if (mode === "etag" && inm === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      return new Response(JSON.stringify(catalog), { headers: mode === "etag" ? { etag: '"v1"' } : {} });
    });

  it("revalidates an expired copy with its ETag, and a 304 renews it", async () => {
    stub();
    await (await import("../queries/connection")).resetDbForTests();
    const { fetchCatalog, CATALOG_TTL_MS } = await import("./client");
    const { getServerSetting } = await import("../lib/serverSettings");
    const t0 = 1_000_000;
    expect(await fetchCatalog(t0)).toHaveLength(1);
    expect(seen).toEqual([{ inm: null }]);
    expect(await getServerSetting<{ etag?: string } | null>("store.catalog", null)).toMatchObject({ at: t0, etag: '"v1"' });
    await fetchCatalog(t0 + CATALOG_TTL_MS - 1);
    expect(seen).toHaveLength(1);
    expect(await fetchCatalog(t0 + CATALOG_TTL_MS + 1)).toHaveLength(1);
    expect(seen[1]).toEqual({ inm: '"v1"' });
    // renewed: the TTL runs again from the 304
    await fetchCatalog(t0 + CATALOG_TTL_MS + 100);
    expect(seen).toHaveLength(2);
    expect(await getServerSetting<{ at: number } | null>("store.catalog", null)).toMatchObject({ at: t0 + CATALOG_TTL_MS + 1 });
  });

  it("a stored copy answers after a restart, and a corrupt one is refetched", async () => {
    stub();
    seen.length = 0;
    mode = "plain";
    // A restart: fresh modules (no memory copy) over a database that keeps the stored one.
    const restart = async (stored: unknown) => {
      vi.resetModules();
      await (await import("../queries/connection")).resetDbForTests();
      await (await import("../lib/serverSettings")).setServerSetting("store.catalog", stored);
      return (await import("./client")).fetchCatalog;
    };
    let fetchCatalog = await restart({ at: 5_000_000, raw: catalog });
    expect(await fetchCatalog(5_000_100)).toHaveLength(1);
    expect(seen).toHaveLength(0);
    fetchCatalog = await restart("garbage");
    expect(await fetchCatalog(5_000_100)).toHaveLength(1);
    expect(seen).toEqual([{ inm: null }]);
    // no ETag stored: a plain request; Worker down: the stale copy
    mode = "down";
    expect(await fetchCatalog(5_000_100 + 13 * 3_600_000)).toHaveLength(1);
    expect(seen[1]).toEqual({ inm: null });
  });
});
