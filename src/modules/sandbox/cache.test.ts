import { describe, expect, it } from "vitest";
import { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, createModuleCache, type CacheBackend } from "./cache";

function memory() {
  const rows = new Map<string, { moduleId: string; key: string; value: Blob; at: number }>();
  const id = (m: string, k: string) => `${m}\n${k}`;
  const b: CacheBackend = {
    get: async (m, k) => rows.get(id(m, k))?.value ?? null,
    put: async (m, k, value, at) => void rows.set(id(m, k), { moduleId: m, key: k, value, at }),
    delete: async (m, k) => void rows.delete(id(m, k)),
    entries: async m => [...rows.values()].filter(r => r.moduleId === m).map(r => ({ key: r.key, size: r.value.size, at: r.at })),
  };
  return { b, rows };
}
const mb = (n: number) => new Blob([new Uint8Array(n * 1024 * 1024)]);

describe("a framed module's cache", () => {
  it("each module its own; at most 32 MB, the oldest written going first", async () => {
    const { b } = memory();
    let t = 0;
    const cache = createModuleCache(b, () => ++t);
    await cache.put("a", "one", mb(12));
    await cache.put("a", "two", mb(12));
    await cache.put("b", "one", mb(30));
    await cache.put("a", "three", mb(12));
    expect(await cache.get("a", "one")).toBeNull();
    expect((await cache.get("a", "two"))?.size).toBe(12 * 1024 * 1024);
    expect((await cache.get("b", "one"))?.size).toBe(30 * 1024 * 1024);
    const total = (await b.entries("a")).reduce((n, e) => n + e.size, 0);
    expect(total).toBeLessThanOrEqual(CACHE_MAX_BYTES);
  });

  it("writes at once still keep under the cap; a rewrite counts once", async () => {
    const { b } = memory();
    const cache = createModuleCache(b);
    await Promise.all(Array.from({ length: 6 }, (_, i) => cache.put("a", `k${i}`, mb(8))));
    await cache.put("a", "k5", mb(8));
    const total = (await b.entries("a")).reduce((n, e) => n + e.size, 0);
    expect(total).toBeLessThanOrEqual(CACHE_MAX_BYTES);
    expect(await cache.get("a", "k5")).not.toBeNull();
    await cache.delete("a", "k5");
    expect(await cache.get("a", "k5")).toBeNull();
  });

  it("at most 256 entries a module, the oldest going first", async () => {
    const { b } = memory();
    let t = 0;
    const cache = createModuleCache(b, () => ++t);
    for (let i = 0; i < CACHE_MAX_ENTRIES + 10; i++) await cache.put("a", `k${i}`, new Blob(["x"]));
    expect(await b.entries("a")).toHaveLength(CACHE_MAX_ENTRIES);
    expect(await cache.get("a", "k0")).toBeNull();
    expect(await cache.get("a", `k${CACHE_MAX_ENTRIES + 9}`)).not.toBeNull();
  });
});
