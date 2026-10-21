import { describe, expect, it, vi } from "vitest";

// Must be set before env.ts is evaluated: the newer name.
process.env.PROVIDERS_READ_ONLY = "1";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

describe("read-only trackers (PROVIDERS_READ_ONLY)", () => {
  it("refuses what may change something, lets reads through, POSTs that read included", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { safeFetch, intentOf } = await import("./http");
    const call = (method: string, intent?: "read" | "write") =>
      safeFetch({ site: "https://t.example", url: "https://t.example/api/x", init: { method }, intent, fail: (s, m) => new Error(`${s} ${m}`) });
    await expect(call("GET")).resolves.toBeInstanceOf(Response);
    await expect(call("POST", "read")).resolves.toBeInstanceOf(Response);
    await expect(call("POST")).rejects.toThrow(/^403 .*read-only/);
    await expect(call("DELETE")).rejects.toThrow(/^403/);
    // A GraphQL query is a POST that reads; a mutation, a POST that writes.
    expect(intentOf("POST", "read")).toBe("read");
    expect(intentOf("POST")).toBe("write");
    expect(intentOf("HEAD")).toBe("read");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never reaches an address the tracker's network forbids, written out or behind a name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const { safeFetch } = await import("./http");
    const call = (url: string, network?: "public" | "private") => safeFetch({ site: url, url, init: {}, fail: (s, m) => new Error(`${s} ${m}`), ...(network ? { network } : {}) });
    await expect(call("http://127.0.0.1:3000/", "private")).rejects.toThrow(/^400/);
    await expect(call("http://10.0.0.5/")).rejects.toThrow(/^400/);
    await expect(call("http://db:5432/", "private")).rejects.toThrow(/^400/);
    await expect(call("http://10.0.0.5/", "private")).resolves.toBeInstanceOf(Response);
  });
});
