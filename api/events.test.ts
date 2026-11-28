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
    // Ephemeral (someone typing): goes out without an id, so the page's place in the stream stays.
    const { publishEphemeral } = await import("./lib/userEvents");
    publishEphemeral(user!.id, { type: "chat", threadId: 3, change: "typing", by: 99 });
    publish(user!.id, { type: "timers", epoch: 8 });
    expect(await until('"epoch":8')).toBe(true);
    const typing = got.slice(got.indexOf("event: chat"));
    expect(typing.split("\n\n")[0]).not.toMatch(/^id:/m);
    expect(typing.split("\n\n")[0]).toContain('"change":"typing"');
    // The next numbered event follows the one before it: typing took no number.
    const ids = [...got.matchAll(/^id: \w+:(\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.at(-1)! - ids.at(-2)!).toBe(1);
    closeAllStreams();
    await until("never");
    expect(streamCount()).toBe(0);
  });
  it("a stream whose session ends (signed out, turned off, reset) gets nothing more and closes", async () => {
    const { publish, streamCount } = await import("./lib/userEvents");
    const { userFromRequest } = await import("./context");
    // A session of its own (the others' stays): signed in again.
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const own = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { user, sessionId } = await userFromRequest(new Request("http://localhost/", { headers: { cookie: own } }));
    const res = await app.request("/api/events", { headers: { cookie: own } });
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let got = "";
    let closed = false;
    const read = async () => {
      const { value, done } = await reader.read();
      if (done) closed = true;
      else got += text.decode(value);
    };
    while (!got.includes("event: hello")) await read();
    const { q } = await import("./queries/connection");
    await q("DELETE FROM sessions WHERE id = ?", sessionId);
    publish(user!.id, { type: "timers", epoch: 42 });
    while (!closed) await read();
    expect(got).not.toContain('"epoch":42');
    expect(streamCount()).toBe(0);
  });

  it("a page reconnecting with its last event id gets what it missed; one too far behind is told to resync", async () => {
    const { publish, closeAllStreams, RUN } = await import("./lib/userEvents");
    const { userFromRequest } = await import("./context");
    const { user } = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    const open = async (lastId?: string) => {
      const res = await app.request("/api/events", { headers: { cookie, ...(lastId ? { "last-event-id": lastId } : {}) } });
      const reader = res.body!.getReader();
      const text = new TextDecoder();
      let got = "";
      const until = async (needle: string) => {
        while (!got.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          got += text.decode(value);
        }
        return got;
      };
      return until;
    };
    publish(user!.id, { type: "timers", epoch: 100 });
    const first = await open();
    const hello = await first("event: hello");
    const id = /id: (\S+)/.exec(hello)![1];
    closeAllStreams();
    publish(user!.id, { type: "timers", epoch: 101 });
    publish(user!.id, { type: "schedule" });
    const again = await (await open(id))("event: schedule");
    expect(again).toContain('"epoch":101');
    expect(again).not.toContain('"epoch":100');
    expect(again).toContain('"resync":false');
    // The page that caused an event is named: its own echo is known as such.
    publish(user!.id, { type: "schedule" }, "client-page-0001");
    const echoed = await (await open(id))("client-page-0001");
    expect(echoed).toContain('"origin":"client-page-0001"');
    closeAllStreams();
    const lost = await (await open("another-run:3"))("event: hello");
    expect(lost).toContain('"resync":true');
    expect(lost).toContain(`id: ${RUN}:`);
    closeAllStreams();
  });
});
