import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

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
  const { appRouter } = await import("../router");
  const resHeaders = new Headers();
  await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: site, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
  const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  const { userFromRequest } = await import("../context");
  const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
  return appRouter.createCaller({
    req: new Request("http://localhost/"),
    resHeaders: new Headers(),
    user: ctx.user,
    sessionId: ctx.sessionId,
  });
}

describe("settings: allowed link domains", () => {
  let me: Awaited<ReturnType<typeof callerFor>>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    me = await callerFor("https://acme.atlassian.net");
  });

  it("starts empty, stores normalized unique domains, sorted", async () => {
    expect((await me.settings.get()).allowedLinkDomains).toEqual([]);
    const s = await me.settings.update({
      allowedLinkDomains: ["https://Drive.Google.com/file/1", "*.atlassian.net", "google.com", "drive.google.com"],
    });
    expect(s.allowedLinkDomains).toEqual(["atlassian.net", "drive.google.com", "google.com"]);
  });

  it("refuses what is not a domain", async () => {
    await expect(me.settings.update({ allowedLinkDomains: ["javascript:alert(1)"] })).rejects.toThrow();
    await expect(me.settings.update({ allowedLinkDomains: ["localhost"] })).rejects.toThrow();
  });

  it("an update without the field keeps them", async () => {
    const s = await me.settings.update({ idleMinutes: 15 });
    expect(s.allowedLinkDomains).toContain("google.com");
  });
});
