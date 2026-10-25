import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";
process.env.STORE_URL = "https://store.example";

describe("the store Worker's answers, bounded", () => {
  it("never follows a redirect (the store's own address only) and refuses an answer too large", async () => {
    const seen: RequestInit[] = [];
    const big = new TextEncoder().encode(`{"items":[${'"x",'.repeat(800_000)}"x"]}`);
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < big.length; i += 65_536) c.enqueue(big.slice(i, i + 65_536));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await (await import("../queries/connection")).resetDbForTests();
    const { fetchCatalog } = await import("./client");
    await expect(fetchCatalog()).rejects.toMatchObject({ code: "rejected", detail: "too large" });
    expect(seen[0]?.redirect).toBe("error");
    vi.unstubAllGlobals();
  });
});
