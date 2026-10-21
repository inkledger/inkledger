import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.endsWith("/remotelink")
      ? [
          { id: 1, object: { url: "https://acme.atlassian.net/wiki/x", title: "Specifiche" }, application: { name: "Confluence" } },
          { id: 2, object: { url: "javascript:alert(1)", title: "Trappola" } },
          { id: 3, object: { url: "https://drive.google.com/d/1" } },
        ]
      : { accountId: "acc-1", displayName: "Mario", avatarUrls: {} };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
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

describe("issues.remoteLinks", () => {
  it("lists the issue's web links, never other schemes", async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const me = await callerFor("https://acme.atlassian.net");
    const links = await me.issues.remoteLinks({ key: "DEMO-1" });
    expect(links).toEqual([
      { id: 1, url: "https://acme.atlassian.net/wiki/x", title: "Specifiche", summary: null, app: "Confluence" },
      { id: 3, url: "https://drive.google.com/d/1", title: "https://drive.google.com/d/1", summary: null, app: null },
    ]);
  });
});
