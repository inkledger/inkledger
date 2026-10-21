import { afterEach, describe, expect, it, vi } from "vitest";

// A server on the user's own network (a LAN or a tailnet address) is reached; the
// same address given as a cloud service's would be refused (core/http.ts).
const ok = () => new Response(JSON.stringify({ value: [], id: 1 }), { status: 200, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("self-hosted trackers on the user's own network", () => {
  it.each([
    ["GitLab", async (base: string) => (await import("./gitlab/client")).gl({ apiBase: `${base}/api/v4`, token: "t" }, "/user")],
    ["Gitea", async (base: string) => (await import("./gitea/client")).gt({ apiBase: `${base}/api/v1`, token: "t" }, "/user")],
    ["YouTrack", async (base: string) => (await import("./youtrack/client")).yt({ apiBase: base, token: "perm:t" }, "/api/users/me")],
    ["Azure DevOps Server", async (base: string) => (await import("./azure/client")).az({ apiBase: `${base}/tfs/DefaultCollection`, token: "t" }, "/_apis/projects")],
  ])("%s at a private address answers", async (_, call) => {
    const fetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetch);
    for (const base of ["http://192.168.1.20", "http://10.0.0.5:8080", "http://100.101.102.103"]) {
      await expect(call(base)).resolves.not.toBeUndefined();
    }
    expect(fetch).toHaveBeenCalled();
  });

  it("the server itself (loopback) is never reached, self-hosted or not", async () => {
    const { gl } = await import("./gitlab/client");
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    await expect(gl({ apiBase: "http://127.0.0.1/api/v4", token: "t" }, "/user")).rejects.toThrow(/not allowed/);
  });
});

describe("the address a person types", () => {
  it("is the server's web address or its API's: the API root either way, its path once", async () => {
    const { apiRootOf: gitlab } = await import("./gitlab/client");
    const { apiRootOf: gitea } = await import("./gitea/client");
    for (const a of ["https://git.example.com", "https://git.example.com/", "https://git.example.com/api/v4", "https://git.example.com/api/v4/"]) expect(gitlab(a)).toBe("https://git.example.com/api/v4");
    expect(gitlab("https://example.com/gitlab")).toBe("https://example.com/gitlab/api/v4");
    for (const a of ["https://code.example.com", "https://code.example.com/api/v1"]) expect(gitea(a)).toBe("https://code.example.com/api/v1");
    expect(gitea("https://example.com/gitea/")).toBe("https://example.com/gitea/api/v1");
  });
});
