// Catalog pictures kept in memory stay within their cap, however many the
// catalog names over time; one picture asked twice at once is fetched once;
// what isn't a picture we show, or doesn't come, is never kept.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const MB = 1024 * 1024;

describe("store pictures in memory", () => {
  let fetched: string[] = [];

  beforeEach(async () => {
    fetched = [];
    (await import("./routes")).storeImages.clear();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url.includes("down")) throw new TypeError("fetch failed");
      if (url.includes("svg")) return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
      if (url.includes("huge")) return new Response(new Uint8Array(2 * MB + 1), { headers: { "content-type": "image/png" } });
      return new Response(new Uint8Array(2 * MB), { headers: { "content-type": "image/png" } });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("many pictures over time: memory stays within 32 MB, the most recent kept", async () => {
    const { fetchImage, storeImages } = await import("./routes");
    for (let i = 0; i < 40; i++) expect((await fetchImage(`https://img.example/${i}.png`))?.body.byteLength).toBe(2 * MB);
    expect(storeImages.totalSize).toBeLessThanOrEqual(32 * MB);
    expect(storeImages.size).toBe(16);
    fetched = [];
    await fetchImage("https://img.example/39.png");
    await fetchImage("https://img.example/0.png");
    expect(fetched).toEqual(["https://img.example/0.png"]);
  });

  it("the same picture asked twice at once is fetched once", async () => {
    const { fetchImage } = await import("./routes");
    const [a, b] = await Promise.all([fetchImage("https://img.example/x.png"), fetchImage("https://img.example/x.png")]);
    expect(a?.body.byteLength).toBe(2 * MB);
    expect(b).toBe(a);
    expect(fetched).toEqual(["https://img.example/x.png"]);
  });

  it("not a picture we show, too big, or not reachable: nothing kept, asked again next time", async () => {
    const { fetchImage, storeImages } = await import("./routes");
    expect(await fetchImage("https://img.example/a.svg")).toBeNull();
    expect(await fetchImage("https://img.example/huge.png")).toBeNull();
    await expect(fetchImage("https://img.example/down.png")).rejects.toThrow("fetch failed");
    expect(storeImages.size).toBe(0);
    await fetchImage("https://img.example/a.svg");
    await expect(fetchImage("https://img.example/down.png")).rejects.toThrow();
    expect(fetched.filter((u) => u.endsWith("a.svg"))).toHaveLength(2);
    expect(fetched.filter((u) => u.endsWith("down.png"))).toHaveLength(2);
  });
});
