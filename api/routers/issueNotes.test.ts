import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NOTE_SIZE } from "@contracts/pinboard";

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

describe("issue notes", () => {
  let me: Awaited<ReturnType<typeof callerFor>>;
  let other: Awaited<ReturnType<typeof callerFor>>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    me = await callerFor("https://acme.atlassian.net");
    other = await callerFor("https://other.atlassian.net");
  });

  it("adds, lists newest first, edits and keeps them private to the user", async () => {
    const a = await me.issueNotes.add({ issueKey: "demo-7", body: "  Chiedere il budget a Luca  " });
    const b = await me.issueNotes.add({ issueKey: "DEMO-7", body: "Commessa ferma fino a lunedì" });
    await me.issueNotes.add({ issueKey: "DEMO-8", body: "altra issue" });
    const list = await me.issueNotes.list({ issueKey: "DEMO-7" });
    expect(list.map((n) => n.id)).toEqual([b.id, a.id]);
    expect(list[1]).toMatchObject({ issueKey: "DEMO-7", body: "Chiedere il budget a Luca", pinnedOn: [] });
    await me.issueNotes.update({ id: a.id, body: "Budget ok" });
    expect((await me.issueNotes.list({ issueKey: "DEMO-7" }))[1].body).toBe("Budget ok");
    // Someone else sees nothing and can touch nothing.
    expect(await other.issueNotes.list({ issueKey: "DEMO-7" })).toEqual([]);
    await expect(other.issueNotes.update({ id: a.id, body: "x" })).rejects.toThrow();
    await expect(other.issueNotes.remove({ id: a.id })).rejects.toThrow();
    await expect(other.pinboard.pinNote({ noteId: a.id })).rejects.toThrow();
    await expect(me.issueNotes.add({ issueKey: "DEMO-7", body: "   " })).rejects.toThrow();
  });

  it("hangs a note beside its issue (pinning the issue too), once per board, tied to it", async () => {
    const [n] = await me.issueNotes.list({ issueKey: "DEMO-7" });
    const r = await me.pinboard.pinNote({ noteId: n.id });
    expect(r.existed).toBe(false);
    const board = await me.pinboard.list();
    const issue = board.find((p) => p.issueKey === "DEMO-7" && p.issueNoteId === null)!;
    const hung = board.find((p) => p.issueNoteId === n.id)!;
    expect(issue).toBeTruthy();
    expect(hung).toMatchObject({ issueKey: "DEMO-7", noteBody: n.body, note: "" });
    // Beside it, not on top of it.
    expect(Math.abs(hung.x - issue.x) >= NOTE_SIZE * 0.75 || Math.abs(hung.y - issue.y) >= NOTE_SIZE * 0.75).toBe(true);
    const again = await me.pinboard.pinNote({ noteId: n.id });
    expect(again).toMatchObject({ id: r.id, existed: true });
    expect((await me.pinboard.list()).filter((p) => p.issueNoteId === n.id)).toHaveLength(1);
    // Pinning the issue again finds its own post-it, not the note's.
    expect(await me.pinboard.add({ issueKey: "DEMO-7" })).toMatchObject({ id: issue.id, existed: true });
    expect((await me.issueNotes.list({ issueKey: "DEMO-7" }))[0].pinnedOn).toHaveLength(1);
  });

  it("writing on the hung post-it changes the note; deleting the note takes its post-its away", async () => {
    const [n] = await me.issueNotes.list({ issueKey: "DEMO-7" });
    const hung = (await me.pinboard.list()).find((p) => p.issueNoteId === n.id)!;
    await me.pinboard.update({ id: hung.id, note: "Riscritta dalla bacheca" });
    expect((await me.issueNotes.list({ issueKey: "DEMO-7" }))[0].body).toBe("Riscritta dalla bacheca");
    const removed = await me.issueNotes.remove({ id: n.id });
    expect((await me.pinboard.list()).some((p) => p.issueNoteId === n.id)).toBe(false);
    // The issue's own post-it stays.
    expect((await me.pinboard.list()).some((p) => p.issueKey === "DEMO-7" && p.issueNoteId === null)).toBe(true);
    const back = await me.issueNotes.restore({ issueKey: removed.issueKey, body: removed.body, createdAt: removed.createdAt.getTime() });
    expect((await me.issueNotes.list({ issueKey: "DEMO-7" })).some((x) => x.id === back.id)).toBe(true);
  });

  it("unhanging a note keeps it on the issue; undo hangs it again", async () => {
    const [n] = await me.issueNotes.list({ issueKey: "DEMO-7" });
    await me.pinboard.pinNote({ noteId: n.id });
    const hung = (await me.pinboard.list()).find((p) => p.issueNoteId === n.id)!;
    const removed = await me.pinboard.remove({ id: hung.id });
    expect((await me.issueNotes.list({ issueKey: "DEMO-7" })).some((x) => x.id === n.id)).toBe(true);
    await me.pinboard.restore({ boardId: removed.boardId!, issueKey: removed.issueKey, issueNoteId: removed.issueNoteId, note: removed.note, color: "pink", x: removed.x, y: removed.y, rotation: removed.rotation });
    expect((await me.pinboard.list()).some((p) => p.issueNoteId === n.id)).toBe(true);
  });
});
