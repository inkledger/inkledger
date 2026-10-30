// The notes' AI actions: "Tidy up with AI" (Original | AI on the same note, kept or
// discarded), and the diary written up as a report or a timeline.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

async function caller() {
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", `u${Math.random()}`, "U");
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  return { userId, c: appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null }) };
}

const { env } = await import("../lib/env");
const saved = { url: env.ollamaUrl, sim: env.ollamaSimulator };
afterEach(() => {
  env.ollamaUrl = saved.url;
  env.ollamaSimulator = saved.sim;
});

describe("notes: tidy up with AI", () => {
  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("the AI copy goes beside the text, which stays as it was (revision, search)", async () => {
    const { c } = await caller();
    env.ollamaSimulator = "1";
    const note = await c.notes.create({ title: "Call", body: "call w/ rossi APP-12 budget 1500" });
    const tidied = await c.notes.tidy({ id: note.id });
    expect(tidied.body).toBe(note.body);
    expect(tidied.contentRevision).toBe(note.contentRevision);
    expect(tidied.ai?.body).toContain("APP-12");
    expect(tidied.ai?.stale).toBe(false);
    expect((await c.notes.tree()).find(n => n.id === note.id)?.hasAi).toBe(true);
    // Searches still find the original's words only.
    expect((await c.notes.search({ query: "rossi" })).results).toHaveLength(1);
  });

  it("Keep AI: the copy becomes the text, the original a version Undo restores; a stale revision conflicts", async () => {
    const { c } = await caller();
    env.ollamaSimulator = "1";
    const note = await c.notes.create({ title: "Retro", body: "went ok" });
    await c.notes.tidy({ id: note.id });
    // The text changed meanwhile: the copy says so, and keeping it over an older revision conflicts.
    const edited = await c.notes.updateContent({ id: note.id, title: "Retro", body: "went ok, mostly", expectedRevision: note.contentRevision });
    if (edited.status !== "updated") throw new Error("not saved");
    expect((await c.notes.get({ id: note.id })).ai?.stale).toBe(true);
    expect((await c.notes.keepAi({ id: note.id, expectedRevision: note.contentRevision })).status).toBe("conflict");
    const kept = await c.notes.keepAi({ id: note.id, expectedRevision: edited.note.contentRevision });
    if (kept.status !== "updated") throw new Error("not kept");
    expect(kept.note.body).toBe("## Retro\n\nwent ok");
    expect(kept.note.ai).toBeNull();
    const versions = await c.notes.versions({ id: note.id });
    const original = versions.find(v => v.id === kept.versionId);
    expect(original?.origin).toBe("ai");
    const back = await c.notes.restoreVersion({ id: note.id, versionId: kept.versionId!, expectedRevision: kept.note.contentRevision });
    expect(back.status === "updated" && back.note.body).toBe("went ok, mostly");
  });

  it("Discard AI, a copy pasted by hand, and the limits", async () => {
    const { c } = await caller();
    const note = await c.notes.create({ title: "Long", body: "x" });
    const pasted = await c.notes.setAi({ id: note.id, markdown: "# Pasted from Claude" });
    expect(pasted.ai?.body).toBe("# Pasted from Claude");
    expect((await c.notes.discardAi({ id: note.id })).ai).toBeNull();
    await expect(c.notes.keepAi({ id: note.id, expectedRevision: note.contentRevision })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // No model here: refused, said in words.
    env.ollamaSimulator = null;
    env.ollamaUrl = null;
    await expect(c.notes.tidy({ id: note.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    env.ollamaSimulator = "1";
    const long = await c.notes.create({ title: "Huge", body: "y".repeat(10_001) });
    await expect(c.notes.tidy({ id: long.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    env.ollamaSimulator = "garbage";
    await expect(c.notes.tidy({ id: note.id })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    // Someone else's note: not found.
    env.ollamaSimulator = "1";
    await expect((await caller()).c.notes.tidy({ id: note.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("notes: the diary written up", () => {
  it("summary and prompt from the period's notes, time and plans; an empty period is said", async () => {
    const { c, userId } = await caller();
    env.ollamaSimulator = "1";
    await c.notes.create({ title: "Call MrCall", body: "Pilot in November", notedOn: "2026-10-28" });
    await q(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://d.example', 'me', 'x', 1)",
      userId
    );
    const [{ id: conn }] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ?", userId);
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'APP-1', 'w1', 3600, ?, 'parser', 1)",
      userId, conn, new Date(2026, 9, 28, 9).getTime()
    );
    const range = { fromDay: "2026-10-28", toDay: "2026-10-29", from: new Date(2026, 9, 28).toISOString(), to: new Date(2026, 9, 30).toISOString() };
    const { prompt } = await c.notes.diaryPrompt({ ...range, mode: "timeline" });
    expect(prompt).toMatch(/chronology of 2026-10-28 to 2026-10-29/);
    expect(prompt).toContain("### Note: Call MrCall\n\nPilot in November");
    expect(prompt).toContain("- APP-1: 1 h\n  - parser");
    const summary = await c.notes.summarize({ ...range, mode: "summary" });
    expect(summary.title).toBe("Report 2026-10-28 – 2026-10-29");
    expect(summary.markdown).toContain("Call MrCall");
    await expect(c.notes.summarize({ fromDay: "2026-01-01", toDay: "2026-01-02", from: new Date(2026, 0, 1).toISOString(), to: new Date(2026, 0, 3).toISOString(), mode: "summary" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(c.notes.diaryPrompt({ ...range, toDay: "2026-12-30", mode: "summary" })).rejects.toThrow();
  });
});
