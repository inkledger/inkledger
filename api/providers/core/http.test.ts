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
    // Without its own error, a provider's refused write is a ProviderError.
    await expect(safeFetch({ site: "https://t.example", url: "https://t.example/api/x", init: { method: "PUT" } })).rejects.toMatchObject({ name: "ProviderError", kind: "readOnly" });
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

  it("a redirect to another origin carries none of the credentials, whatever header they ride in", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push(new Headers(init.headers));
        return url.startsWith("https://t.example/") ? new Response(null, { status: 302, headers: { location: "https://cdn.example/file" } }) : new Response("ok");
      }),
    );
    const { safeFetch } = await import("./http");
    const headers = { Authorization: "Bearer a", "PRIVATE-TOKEN": "b", "X-Api-Key": "c", "X-Redmine-API-Key": "d", "Shortcut-Token": "e", Cookie: "f=1", Accept: "image/*" };
    await safeFetch({ site: "https://t.example", url: "https://t.example/file", init: { headers }, allowCrossOrigin: true });
    expect(seen).toHaveLength(2);
    expect([...seen[0].keys()]).toHaveLength(7);
    expect([...seen[1].entries()]).toEqual([["accept", "image/*"]]);
  });

  it("a hop to another origin connects as on the public internet, whatever the tracker's own network", async () => {
    const used: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit & { dispatcher?: unknown }) => {
        used.push(init.dispatcher);
        return url.startsWith("https://t.example/") ? new Response(null, { status: 302, headers: { location: "https://cdn.example/file" } }) : new Response("ok");
      }),
    );
    const { safeFetch, agents } = await import("./http");
    await safeFetch({ site: "https://t.example", url: "https://t.example/file", init: {}, allowCrossOrigin: true, network: "private" });
    expect(used[0]).toBe(agents.private);
    expect(used[1]).toBe(agents.public);
  });

  it("a redirect refused is an answer outside the contract: neither the tracker's refusal nor an outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } })));
    const { safeFetch } = await import("./http");
    await expect(safeFetch({ site: "https://t.example", url: "https://t.example/api/x", init: {} })).rejects.toMatchObject({ name: "ProviderError", kind: "incompatible" });
  });

  it("a tracker that goes silent is cut by idle timeouts on the guarded agents, never by a total deadline", async () => {
    const { agents, AGENT_TIMEOUTS } = await import("./http");
    for (const [network, agent] of Object.entries(agents) as [keyof typeof AGENT_TIMEOUTS, (typeof agents)[keyof typeof agents]][]) {
      expect(AGENT_TIMEOUTS[network].headersTimeout).toBeGreaterThan(0);
      expect(AGENT_TIMEOUTS[network].bodyTimeout).toBeGreaterThan(0);
      const options = Object.getOwnPropertySymbols(agent)
        .map((s) => (agent as unknown as Record<symbol, unknown>)[s])
        .find((v): v is { headersTimeout?: number; bodyTimeout?: number } => typeof v === "object" && v !== null && "connect" in v);
      expect(options).toMatchObject(AGENT_TIMEOUTS[network]);
    }
  });
});
