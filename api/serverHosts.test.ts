import { jiraSignIn } from "./testing/signIn";
import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";
process.env.ALLOWED_HOSTS = "localhost,my-mac.tail1.ts.net";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const who = url.includes("other") ? "acc-2" : "acc-1";
    return new Response(JSON.stringify({ accountId: who, displayName: "Mario", avatarUrls: {} }), {
      headers: { "Content-Type": "application/json" },
    });
  }),
);

async function callerFor(site: string) {
  const { appRouter } = await import("./router");
  const resHeaders = new Headers();
  await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: site, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
  const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  const { userFromRequest } = await import("./context");
  const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
  return appRouter.createCaller({
    req: new Request("http://localhost/"),
    resHeaders: new Headers(),
    user: ctx.user,
    sessionId: ctx.sessionId,
  });
}

describe("server hosts added at runtime (local network sharing)", () => {
  // Booting the app (fresh database and migrations) is setup, not the test's time.
  beforeAll(async () => {
    const conn = await import("./queries/connection");
    await conn.resetDbForTests();
    await import("./boot");
  });

  it("a LAN address is refused until the signed-in user adds it", async () => {
    (await import("./lib/serverHosts")).resetServerHostsCache();
    const app = (await import("./boot")).default;
    const health = (host: string) => app.request("/api/health", { headers: { host } });
    expect((await health("192.168.1.20:47843")).status).toBe(421);
    expect((await health("my-mac.local:47843")).status).toBe(421);

    const me = await callerFor("https://acme.atlassian.net");
    const { hosts } = await me.info.addHosts({ hosts: ["My-Mac.local", "192.168.1.20"] });
    expect(hosts.sort()).toEqual(["192.168.1.20", "my-mac.local"]);
    expect((await health("192.168.1.20:47843")).status).toBe(200);
    expect((await health("my-mac.local:47843")).status).toBe(200);
    // Still refused: anything else.
    expect((await health("evil.example.com")).status).toBe(421);
  });

  it("never pins the host to https (HSTS would break plain http on localhost)", async () => {
    const app = (await import("./boot")).default;
    const res = await app.request("/api/health", { headers: { host: "localhost:47823" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("only .local names and private addresses can be added", async () => {
    const me = await callerFor("https://acme.atlassian.net");
    await expect(me.info.addHosts({ hosts: ["evil.example.com"] })).rejects.toThrow();
    await expect(me.info.addHosts({ hosts: ["8.8.8.8"] })).rejects.toThrow();
    await expect(me.info.addHosts({ hosts: ["100.101.1.2"] })).rejects.toThrow();
  });

  it("the Tailscale name and the user's DNS names, set from the app, are accepted", async () => {
    const app = (await import("./boot")).default;
    const health = (host: string) => app.request("/api/health", { headers: { host } });
    const me = await callerFor("https://acme.atlassian.net");
    expect((await health("studio-mac.tail9.ts.net")).status).toBe(421);
    expect((await health("ikl.casa:47843")).status).toBe(421);
    const access = await me.info.setAccess({ tailscaleHost: "Studio-Mac.tail9.ts.net.", customHosts: ["ikl.casa", "ikl.casa"] });
    expect(access).toEqual({ tailscaleHost: "studio-mac.tail9.ts.net", tailscalePort: null, customHosts: ["ikl.casa"] });
    expect((await health("studio-mac.tail9.ts.net")).status).toBe(200);
    expect((await health("ikl.casa:47843")).status).toBe(200);
    expect((await me.info.get()).tailnetHosts).toContain("studio-mac.tail9.ts.net");
    // Published on its own port: the phone's address carries it.
    await me.info.setAccess({ tailscalePort: 47823 });
    expect((await me.info.get()).tailnetOrigins).toContain("https://studio-mac.tail9.ts.net:47823");
    // Bad names are refused; clearing removes them.
    await expect(me.info.setAccess({ tailscaleHost: "tail9.ts.net" })).rejects.toThrow();
    await expect(me.info.setAccess({ customHosts: ["not a name"] })).rejects.toThrow();
    await me.info.setAccess({ tailscaleHost: null, customHosts: [] });
    expect((await health("ikl.casa:47843")).status).toBe(421);
  });

  it("needs a session", async () => {
    const { appRouter } = await import("./router");
    const anon = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: null, sessionId: null });
    await expect(anon.info.addHosts({ hosts: ["192.168.1.30"] })).rejects.toThrow();
  });
});
