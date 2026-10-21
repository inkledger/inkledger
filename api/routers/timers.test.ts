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

describe("timers across devices: one owner, take-over on purpose, never counted twice", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let on: (deviceId: string | undefined, ua?: string) => Caller;
  let q: typeof import("../queries/connection").q;
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    q = conn.q;
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    on = (deviceId, ua = MAC) =>
      appRouter.createCaller({ req: new Request("http://localhost/", { headers: { "user-agent": ua } }), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId, deviceId });
  });

  const conflictOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const err = e as { code?: string; cause?: { info?: unknown } };
      return { code: err.code, info: err.cause?.info as { reason: string; ownerLabel: string; issueKey: string } | undefined };
    }
    throw new Error("expected a conflict");
  };
  const reset = () => q("DELETE FROM timers");

  it("near-simultaneous Play on two devices: one wins, the other is told who holds it", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    const phone = on("device-phone-1", PHONE);
    const results = await Promise.allSettled([laptop.timers.start({ issueKey: "PRJ-1" }), phone.timers.start({ issueKey: "PRJ-2" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost && (lost.reason as { code: string }).code).toBe("CONFLICT");
    const running = (await laptop.timers.list()).filter((t) => t.state === "running");
    expect(running).toHaveLength(1);
  });

  it("the other device sees the timer, who holds it and since when; Play there is refused without force", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    const phone = on("device-phone-1", PHONE);
    await laptop.timers.start({ issueKey: "PRJ-1" });
    const [seen] = await phone.timers.list();
    expect(seen).toMatchObject({ state: "running", ownerLabel: "Chrome · macOS", ownedHere: false, heldElsewhere: true, orphaned: false });
    expect(seen.runningSince).toBeInstanceOf(Date);
    expect((await laptop.timers.list())[0]).toMatchObject({ ownedHere: true, heldElsewhere: false });
    for (const p of [phone.timers.start({ issueKey: "PRJ-1" }), phone.timers.start({ issueKey: "PRJ-2" }), phone.timers.pause({ issueKey: "PRJ-1" }), phone.timers.stop({ issueKey: "PRJ-1" }), phone.timers.discard({ issueKey: "PRJ-1" })]) {
      const c = await conflictOf(p);
      expect(c).toMatchObject({ code: "CONFLICT", info: { reason: "held", ownerLabel: "Chrome · macOS", issueKey: "PRJ-1" } });
    }
    // A note is anyone's to write.
    await phone.timers.setNote({ issueKey: "PRJ-1", note: "from the phone" });
    expect((await laptop.timers.list())[0].note).toBe("from the phone");
  });

  it("taking over the same issue moves control only: the time keeps running, once", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    const phone = on("device-phone-1", PHONE);
    await laptop.timers.start({ issueKey: "PRJ-1" });
    await q("UPDATE timers SET accumulated_seconds = 600, started_at = ? WHERE issue_key = 'PRJ-1'", Date.now() - 120_000);
    const r = await phone.timers.start({ issueKey: "PRJ-1", force: true });
    expect(r).toMatchObject({ tookOver: true, switchedFrom: null });
    const rows = await q<{ n: number }>("SELECT count(*)::int AS n FROM timers");
    expect(rows[0].n).toBe(1);
    const [t] = await phone.timers.list();
    expect(t).toMatchObject({ state: "running", ownedHere: true, ownerLabel: "Safari · iPhone" });
    expect(t.elapsedSeconds).toBeGreaterThanOrEqual(720);
    expect(t.elapsedSeconds).toBeLessThan(730);
    // The laptop now acts only by taking it back; its heartbeat says it lost it.
    expect(await laptop.timers.heartbeat()).toMatchObject({ owned: false });
    expect((await conflictOf(laptop.timers.pause({ issueKey: "PRJ-1" }))).info?.reason).toBe("held");
  });

  it("an action on an older view is refused as moved", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    const { epoch } = await laptop.timers.start({ issueKey: "PRJ-1" });
    await laptop.timers.start({ issueKey: "PRJ-1", force: true });
    await on("device-phone-1").timers.start({ issueKey: "PRJ-1", force: true });
    await laptop.timers.start({ issueKey: "PRJ-1", force: true });
    expect((await conflictOf(laptop.timers.pause({ issueKey: "PRJ-1", epoch }))).info?.reason).toBe("moved");
    const now = (await laptop.timers.list())[0].epoch;
    expect(await laptop.timers.pause({ issueKey: "PRJ-1", epoch: now })).toMatchObject({ ok: true });
  });

  it("a retried action answers its first result instead of acting twice", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    await laptop.timers.start({ issueKey: "PRJ-1" });
    const first = await laptop.timers.stop({ issueKey: "PRJ-1", opId: "op-stop-0001" });
    await laptop.timers.start({ issueKey: "PRJ-1" });
    const again = await laptop.timers.stop({ issueKey: "PRJ-1", opId: "op-stop-0001" });
    expect(again).toEqual(first);
    // The retry did not stop the timer started meanwhile.
    expect((await laptop.timers.list())[0].state).toBe("running");
    const s1 = await laptop.timers.start({ issueKey: "PRJ-3", opId: "op-start-0001" });
    const s2 = await laptop.timers.start({ issueKey: "PRJ-3", opId: "op-start-0001" });
    expect(s2).toEqual(s1);
  });

  it("a device that goes silent leaves the timer running and free to take; back again, it renews", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    const phone = on("device-phone-1", PHONE);
    await laptop.timers.start({ issueKey: "PRJ-1" });
    expect(await laptop.timers.heartbeat()).toMatchObject({ owned: true });
    // The laptop slept: its lease ran out.
    await q("UPDATE timers SET lease_until = ?", Date.now() - 1000);
    const [orphan] = await phone.timers.list();
    expect(orphan).toMatchObject({ state: "running", heldElsewhere: false, orphaned: true });
    // Back before anyone took it: its heartbeat holds it again.
    expect(await laptop.timers.heartbeat()).toMatchObject({ owned: true });
    expect((await phone.timers.list())[0]).toMatchObject({ heldElsewhere: true });
    // Silent again; the phone takes it without forcing, and the time is not restarted.
    await q("UPDATE timers SET lease_until = ?, accumulated_seconds = 300", Date.now() - 1000);
    expect(await phone.timers.start({ issueKey: "PRJ-1" })).toMatchObject({ tookOver: false });
    const [t] = await phone.timers.list();
    expect(t).toMatchObject({ ownedHere: true });
    expect(t.elapsedSeconds).toBeGreaterThanOrEqual(300);
  });

  it("tabs of one browser share its device: no lock between them", async () => {
    await reset();
    const tab1 = on("device-laptop-1");
    const tab2 = on("device-laptop-1");
    await tab1.timers.start({ issueKey: "PRJ-1" });
    expect(await tab2.timers.pause({ issueKey: "PRJ-1" })).toMatchObject({ ok: true });
  });

  it("logging the timer from two devices at once: one worklog, the other told it was logged", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    const phone = on("device-phone-1", PHONE);
    await laptop.timers.start({ issueKey: "PRJ-1" });
    const stop = await laptop.timers.stop({ issueKey: "PRJ-1" });
    const { claimTimerSeconds } = await import("./timers");
    expect((await laptop.timers.list())[0].state).toBe("paused");
    const ids = (await q<{ user_id: number }>("SELECT user_id FROM timers"))[0].user_id;
    const [a, b] = await Promise.all([claimTimerSeconds(ids, "PRJ-1", stop.seconds), claimTimerSeconds(ids, "PRJ-1", stop.seconds)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await phone.timers.list()).toEqual([]);
    // A worklog that then fails puts the time back.
    await laptop.timers.start({ issueKey: "PRJ-2" });
    await laptop.timers.stop({ issueKey: "PRJ-2" });
    const claim = await claimTimerSeconds(ids, "PRJ-2", 60);
    expect(await laptop.timers.list()).toEqual([]);
    await claim?.undo();
    expect((await laptop.timers.list())[0]).toMatchObject({ issueKey: "PRJ-2", state: "paused" });
  });

  it("every change reaches the user's open pages as an event", async () => {
    await reset();
    const { subscribe } = await import("../lib/userEvents");
    const ids = async () => (await q<{ id: number }>("SELECT id FROM users LIMIT 1"))[0].id;
    const seen: string[] = [];
    const off = subscribe(await ids(), (e) => seen.push(e.type), () => undefined);
    const laptop = on("device-laptop-1");
    await laptop.timers.start({ issueKey: "PRJ-1" });
    await laptop.timers.setNote({ issueKey: "PRJ-1", note: "x" });
    await laptop.timers.pause({ issueKey: "PRJ-1" });
    off();
    expect(seen).toEqual(["timers", "timers", "timers"]);
  });
});
