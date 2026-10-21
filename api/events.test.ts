import { jiraSignIn } from "./testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} }), { headers: { "Content-Type": "application/json" } })),
);

describe("GET /api/events", () => {
  let app: typeof import("./boot").default;
  let cookie = "";

  beforeAll(async () => {
    await (await import("./queries/connection")).resetDbForTests();
    app = (await import("./boot")).default;
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  });

  it("needs a session", async () => {
    expect((await app.request("/api/events")).status).toBe(401);
  });

  it("says hello, then names what changed for this user; closes at shutdown", async () => {
    const res = await app.request("/api/events", { headers: { cookie } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let got = "";
    const until = async (needle: string) => {
      while (!got.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        got += text.decode(value);
      }
      return got.includes(needle);
    };
    expect(await until("event: hello")).toBe(true);
    const { publish, closeAllStreams, streamCount } = await import("./lib/userEvents");
    const { userFromRequest } = await import("./context");
    const { user } = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    expect(streamCount()).toBe(1);
    publish(user!.id + 1000, { type: "timers", epoch: 9 });
    publish(user!.id, { type: "timers", epoch: 7 });
    expect(await until("event: timers")).toBe(true);
    expect(got).toContain('"epoch":7');
    expect(got).not.toContain('"epoch":9');
    closeAllStreams();
    await until("never");
    expect(streamCount()).toBe(0);
  });
});
