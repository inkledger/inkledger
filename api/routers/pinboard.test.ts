import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { CANVAS_H, CANVAS_W, MAX_NOTES, NOTE_SIZE } from "@contracts/pinboard";

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

describe("pinboard", () => {
  let me: Awaited<ReturnType<typeof callerFor>>;
  let other: Awaited<ReturnType<typeof callerFor>>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    me = await callerFor("https://acme.atlassian.net");
    other = await callerFor("https://other.atlassian.net");
  });

  it("pins an issue once; pinning again brings it to the front", async () => {
    const a = await me.pinboard.add({ issueKey: "demo-1", x: 100, y: 120 });
    const b = await me.pinboard.add({ note: "Chiedere a Luca", color: "pink" });
    const again = await me.pinboard.add({ issueKey: "DEMO-1" });
    expect(again).toMatchObject({ id: a.id, existed: true });
    const list = await me.pinboard.list();
    expect(list.map((n) => n.id)).toEqual([b.id, a.id]); // a now on top
    expect(list.find((n) => n.id === a.id)).toMatchObject({ issueKey: "DEMO-1", x: 100, y: 120 });
    const free = list.find((n) => n.id === b.id)!;
    expect(free).toMatchObject({ issueKey: null, note: "Chiedere a Luca", color: "pink" });
    expect(Math.abs(free.rotation)).toBeGreaterThan(0);
    expect(Math.abs(free.rotation)).toBeLessThanOrEqual(4);
  });

  it("keeps post-its on the canvas, writes notes, recolours", async () => {
    const [first] = await me.pinboard.list();
    await me.pinboard.update({ id: first.id, x: -50, y: 99999, note: "urgente", color: "green", toFront: true });
    const moved = (await me.pinboard.list()).find((n) => n.id === first.id)!;
    expect(moved).toMatchObject({ x: 0, y: CANVAS_H - NOTE_SIZE, note: "urgente", color: "green" });
    await me.pinboard.update({ id: first.id, x: CANVAS_W * 2 });
    expect((await me.pinboard.list()).find((n) => n.id === first.id)!.x).toBe(CANVAS_W - NOTE_SIZE);
  });

  it("a free note becomes an issue; remove and restore", async () => {
    const free = (await me.pinboard.list()).find((n) => n.issueKey === null)!;
    await me.pinboard.link({ id: free.id, issueKey: "NEW-9" });
    const removed = await me.pinboard.remove({ id: free.id });
    expect((await me.pinboard.list()).some((n) => n.id === free.id)).toBe(false);
    await me.pinboard.restore({
      boardId: removed.boardId!,
      issueKey: removed.issueKey,
      note: removed.note,
      color: removed.color as "green",
      x: removed.x,
      y: removed.y,
      rotation: removed.rotation,
    });
    expect((await me.pinboard.list()).some((n) => n.issueKey === "NEW-9" && n.x === removed.x)).toBe(true);
  });

  it("each user sees and touches only their own board", async () => {
    expect(await other.pinboard.list()).toEqual([]);
    const [mine] = await me.pinboard.list();
    await expect(other.pinboard.update({ id: mine.id, x: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.pinboard.remove({ id: mine.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses more than the maximum", async () => {
    const have = (await other.pinboard.list()).length;
    for (let i = have; i < MAX_NOTES; i++) await other.pinboard.add({ note: `n${i}` });
    await expect(other.pinboard.add({ note: "troppi" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("named boards: create, rename, the same issue on two, delete with its notes", async () => {
    const [first] = await me.pinboard.boards();
    expect(first.name).toBe("My board");
    const { id: sprint } = await me.pinboard.createBoard({ name: "  Sprint 42 " });
    await me.pinboard.renameBoard({ id: sprint, name: "Sprint 43" });
    await me.pinboard.add({ boardId: sprint, issueKey: "DEMO-1" });
    const again = await me.pinboard.add({ boardId: sprint, issueKey: "DEMO-1" });
    expect(again.existed).toBe(true);
    expect(again.boardName).toBe("Sprint 43");
    // the same issue is also on the first board, as a separate note
    expect((await me.pinboard.list({ boardId: first.id })).some((n) => n.issueKey === "DEMO-1")).toBe(true);
    expect((await me.pinboard.list({ boardId: sprint })).map((n) => n.issueKey)).toEqual(["DEMO-1"]);
    const boards = await me.pinboard.boards();
    expect(boards.find((b) => b.id === sprint)).toMatchObject({ name: "Sprint 43", count: 1 });
    await me.pinboard.deleteBoard({ id: sprint });
    expect((await me.pinboard.boards()).map((b) => b.id)).toEqual([first.id]);
    await expect(me.pinboard.deleteBoard({ id: first.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(me.pinboard.createBoard({ name: "   " })).rejects.toThrow(/name/);
  });

  it("says where an issue is pinned; unpins it from one board, and Undo puts it back", async () => {
    const [first] = await me.pinboard.boards();
    const { id: second } = await me.pinboard.createBoard({ name: "Second" });
    await me.pinboard.add({ boardId: first.id, issueKey: "PIN-1" });
    // A private note's post-it is not the issue's own.
    const where = async () => (await me.pinboard.where({ issueKey: "pin-1" })).boards.map((b) => [b.name, b.noteId !== null]);
    expect(await where()).toEqual([["My board", true], ["Second", false]]);
    await me.pinboard.add({ boardId: second, issueKey: "PIN-1" });
    expect(await where()).toEqual([["My board", true], ["Second", true]]);
    const removed = await me.pinboard.unpinIssue({ boardId: first.id, issueKey: "PIN-1" });
    expect(await where()).toEqual([["My board", false], ["Second", true]]);
    await expect(me.pinboard.unpinIssue({ boardId: first.id, issueKey: "PIN-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await me.pinboard.restore({ boardId: removed.boardId!, issueKey: removed.issueKey, note: removed.note, color: removed.color as "yellow", x: removed.x, y: removed.y, rotation: removed.rotation });
    expect(await where()).toEqual([["My board", true], ["Second", true]]);
    expect((await me.pinboard.where({ issueKey: "PIN-1" })).hiddenByBucket).toBe(false);
    // Another user's board: neither read nor unpinned.
    await expect(other.pinboard.unpinIssue({ boardId: second, issueKey: "PIN-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await other.pinboard.where({ issueKey: "PIN-1" })).boards.every((b) => b.noteId === null && b.id !== second)).toBe(true);
    await me.pinboard.deleteBoard({ id: second });
  });

  it("boards are private", async () => {
    const [mine] = await me.pinboard.boards();
    await expect(other.pinboard.list({ boardId: mine.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.pinboard.add({ boardId: mine.id, note: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.pinboard.renameBoard({ id: mine.id, name: "mia" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a TODO on the pinboard", () => {
  let me: Awaited<ReturnType<typeof callerFor>>;
  let other: Awaited<ReturnType<typeof callerFor>>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    me = await callerFor("https://acme.atlassian.net");
    other = await callerFor("https://other.atlassian.net");
  });

  it("hangs once per board and shows the TODO as it is; written or ticked there, it is the TODO", async () => {
    const todo = await me.todos.add({ text: "call Anna", dueOn: "2026-10-24", priority: 1 });
    const a = await me.pinboard.pinTodo({ todoId: todo.id });
    const again = await me.pinboard.pinTodo({ todoId: todo.id });
    expect(again).toMatchObject({ id: a.id, existed: true });
    const [n] = (await me.pinboard.list()).filter((x) => x.todoId === todo.id);
    expect(n).toMatchObject({ issueKey: null, todo: { id: todo.id, text: "call Anna", dueOn: "2026-10-24", done: false, priority: 1 } });
    // Rewritten on the post-it: the TODO's text.
    await me.pinboard.update({ id: a.id, note: "call Anna back" });
    expect((await me.todos.list({ view: "upcoming", today: "2026-10-23" })).map((x) => x.text)).toEqual(["call Anna back"]);
    // Ticked in the list: done on the post-it too.
    await me.todos.update({ id: todo.id, done: true });
    expect((await me.pinboard.list()).find((x) => x.id === a.id)?.todo?.done).toBe(true);
    // Not someone else's.
    await expect(other.pinboard.pinTodo({ todoId: todo.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Its issue is the TODO's: no linking the post-it itself.
    await expect(me.pinboard.link({ id: a.id, issueKey: "DEMO-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("copied once per board; put back by Undo while the TODO is there; gone with its TODO", async () => {
    const todo = await me.todos.add({ text: "review" });
    const a = await me.pinboard.pinTodo({ todoId: todo.id });
    const second = await me.pinboard.createBoard({ name: "Second" });
    const c1 = await me.pinboard.copy({ id: a.id, boardId: second.id, move: false });
    const c2 = await me.pinboard.copy({ id: a.id, boardId: second.id, move: false });
    expect(c2).toMatchObject({ id: c1.id, existed: true });
    const gone = await me.pinboard.remove({ id: a.id });
    await me.pinboard.restore({ boardId: gone.boardId ?? 0, issueKey: null, todoId: gone.todoId, note: gone.note, color: gone.color as "green", x: gone.x, y: gone.y, rotation: gone.rotation });
    expect((await me.pinboard.list({ boardId: gone.boardId ?? undefined })).some((x) => x.todo?.id === todo.id)).toBe(true);
    await me.todos.remove({ id: todo.id });
    expect((await me.pinboard.list({ boardId: second.id })).some((x) => x.todoId === todo.id)).toBe(false);
  });
});
