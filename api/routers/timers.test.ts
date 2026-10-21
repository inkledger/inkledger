import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";

vi.stubGlobal(
  "fetch",
  vi.fn(async () =>
    new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} }), {
      headers: { "Content-Type": "application/json" },
    }),
  ),
);

describe("timers: note and trim", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let setAccumulated: (key: string, seconds: number, state: "running" | "paused") => Promise<void>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({
      req: new Request("http://localhost/"),
      resHeaders: new Headers(),
      user: ctx.user,
      sessionId: ctx.sessionId,
    });
    setAccumulated = async (key, seconds, state) => {
      await conn.q("UPDATE timers SET accumulated_seconds = ?, started_at = ?, state = ? WHERE issue_key = ?", seconds, Date.now(), state, key);
    };
  });

  it("keeps a note and hands it over when switching issue", async () => {
    await caller.timers.start({ issueKey: "PRJ-1" });
    await caller.timers.setNote({ issueKey: "PRJ-1", note: "Bug analysis" });
    expect((await caller.timers.list())[0].note).toBe("Bug analysis");
    const r = await caller.timers.start({ issueKey: "PRJ-2" });
    expect(r.switchedFrom?.note).toBe("Bug analysis");
    expect((await caller.timers.stop({ issueKey: "PRJ-1" })).note).toBe("Bug analysis");
  });

  it("trims away time from a running timer", async () => {
    await setAccumulated("PRJ-2", 3600, "running");
    const r = await caller.timers.trim({ issueKey: "PRJ-2", seconds: 600 });
    expect(r.elapsedSeconds).toBeGreaterThanOrEqual(3000);
    expect(r.elapsedSeconds).toBeLessThan(3010);
    const t = (await caller.timers.list()).find((x) => x.issueKey === "PRJ-2");
    expect(t?.state).toBe("running");
  });

  it("never goes below zero, also when paused", async () => {
    await setAccumulated("PRJ-1", 120, "paused");
    expect((await caller.timers.trim({ issueKey: "PRJ-1", seconds: 900 })).elapsedSeconds).toBe(0);
    expect((await caller.timers.trim({ issueKey: "NOPE-1", seconds: 60 })).found).toBe(false);
  });

  it("concurrent starts on different issues leave a single running timer", async () => {
    await Promise.all([
      caller.timers.start({ issueKey: "PRJ-7" }),
      caller.timers.start({ issueKey: "PRJ-8" }),
      caller.timers.start({ issueKey: "prj-9" }),
    ]);
    const running = (await caller.timers.list()).filter((t) => t.state === "running");
    expect(running).toHaveLength(1);
    await expect(caller.timers.start({ issueKey: "not a key" })).rejects.toThrow();
  });
});
