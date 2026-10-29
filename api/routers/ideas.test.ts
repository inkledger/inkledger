// Ideas in triage (docs/work/ideas/triage.md R-2.1–R-2.3, R-2.7, R-2.9): capture, readiness, ownership, the trash.
import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

async function makeUser(name: string) {
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name);
  const [{ id: connId }] = await q<{ id: number }>(
    "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://jira.example', 'me', '{}', 'x', 1) RETURNING id",
    userId,
  );
  const [{ id: containerId }] = await q<{ id: number }>("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (?, '1', 'APP', 'App', 1) RETURNING id", connId);
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  return { userId, containerId, caller: appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null }) };
}

describe("ideas", () => {
  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("a capture over fifty lines is refused", async () => {
    const u = await makeUser("i1");
    const lines = Array.from({ length: 51 }, (_, i) => `idea ${i}`).join("\n");
    await expect(u.caller.ideas.capture({ text: lines })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Up to 50 ideas at a time: split the list." });
    expect(await u.caller.ideas.list({})).toEqual([]);
    // Fifty is fine; they arrive in Raw, at the top, in the order written.
    const made = await u.caller.ideas.capture({ text: lines.split("\n").slice(0, 50).join("\n") });
    expect(made).toHaveLength(50);
    await u.caller.ideas.capture({ text: "1) newer" });
    const raw = await u.caller.ideas.list({ states: ["raw"] });
    expect(raw.slice(0, 3).map((i) => i.title)).toEqual(["newer", "idea 0", "idea 1"]);
    await expect(u.caller.ideas.capture({ text: " - \n  \n* " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("another user's ideas are not found", async () => {
    const a = await makeUser("i2a");
    const b = await makeUser("i2b");
    const [idea] = await a.caller.ideas.capture({ text: "Mine" });
    for (const call of [
      () => b.caller.ideas.get({ id: idea.id }),
      () => b.caller.ideas.update({ id: idea.id, title: "Theirs" }),
      () => b.caller.ideas.move({ id: idea.id, state: "refining", index: 0 }),
      () => b.caller.ideas.remove({ id: idea.id }),
      () => b.caller.ideas.restore({ id: idea.id }),
    ])
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await a.caller.ideas.get({ id: idea.id })).title).toBe("Mine");
    expect(await b.caller.ideas.list({})).toEqual([]);
  });

  it("a project must be one of mine", async () => {
    const a = await makeUser("i3a");
    const b = await makeUser("i3b");
    await expect(b.caller.ideas.capture({ text: "Into A's", containerId: a.containerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [idea] = await b.caller.ideas.capture({ text: "Mine", containerId: b.containerId });
    expect(idea.container).toEqual({ id: b.containerId, key: "APP", name: "App" });
    await expect(b.caller.ideas.update({ id: idea.id, containerId: a.containerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await b.caller.ideas.update({ id: idea.id, containerId: null })).container).toBeNull();
    // An archived connection's projects are not offered either.
    await q("UPDATE connections SET archived_at = 1 WHERE id = (SELECT connection_id FROM containers WHERE id = ?)", b.containerId);
    await expect(b.caller.ideas.update({ id: idea.id, containerId: b.containerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ready needs criteria and answers", async () => {
    const u = await makeUser("i4");
    const [idea] = await u.caller.ideas.capture({ text: "Estimate issues" });
    await u.caller.ideas.move({ id: idea.id, state: "refining", index: 0 });
    await expect(u.caller.ideas.move({ id: idea.id, state: "ready", index: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Add at least one \"done when\" first." });
    await u.caller.ideas.update({
      id: idea.id,
      acceptance: [{ id: "a1", text: "A range on the issue page" }],
      questions: [{ id: "q1", text: "Which statuses count?", answer: "", blocking: true }],
    });
    await expect(u.caller.ideas.move({ id: idea.id, state: "ready", index: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Answer the questions that must be answered first." });
    await u.caller.ideas.update({ id: idea.id, questions: [{ id: "q1", text: "Which statuses count?", answer: "Doing ones", blocking: true }] });
    expect((await u.caller.ideas.move({ id: idea.id, state: "ready", index: 0 })).state).toBe("ready");
    // Promoted only through its issue.
    await expect(u.caller.ideas.move({ id: idea.id, state: "promoted", index: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await u.caller.ideas.counts()).toEqual({ raw: 0, refining: 0, ready: 1, promoted: 0, discarded: 0 });
  });

  it("deleted ideas come back with undo and go after thirty days", async () => {
    const u = await makeUser("i5");
    const [idea] = await u.caller.ideas.capture({ text: "Maybe later" });
    await u.caller.ideas.remove({ id: idea.id });
    expect(await u.caller.ideas.list({})).toEqual([]);
    await expect(u.caller.ideas.get({ id: idea.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await u.caller.ideas.restore({ id: idea.id });
    expect((await u.caller.ideas.list({})).map((i) => i.id)).toEqual([idea.id]);
    await u.caller.ideas.remove({ id: idea.id });
    const { purgeIdeas } = await import("./ideas");
    const DAY = 86_400_000;
    expect(await purgeIdeas(Date.now() + 29 * DAY)).toBe(0);
    expect(await purgeIdeas(Date.now() + 31 * DAY)).toBeGreaterThanOrEqual(1);
    await expect(u.caller.ideas.restore({ id: idea.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
