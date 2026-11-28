import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/**
 * Chat files (api/chat/files.ts) and publishing a message on the tracker (api/chat/store.ts publish):
 * the kind read from the bytes, programs refused, sealed per row, served to members only (a file
 * not sent yet to its uploader only); a message published once, as the caller, someone else's quoted.
 */

const comments: { key: string; text: string; connectionId?: number }[] = [];
const fail = { next: false };
vi.mock("../routers/issues", async (original) => ({
  ...(await original<typeof import("../routers/issues")>()),
  addIssueComment: vi.fn(async (_user: unknown, key: string, text: string, connectionId?: number) => {
    if (fail.next) {
      fail.next = false;
      throw new Error("tracker down");
    }
    comments.push({ key, text, connectionId });
    return { id: "c-" + comments.length };
  }),
}));

const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => (await import("../queries/connection")).q<T>(text, ...params);
const one = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T> => (await q<T>(text, ...params))[0];

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000002800000016808060000000000", "hex");
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"), Buffer.from("ffc0001108012c01f403012200021101031101", "hex")]);
const GIF = Buffer.from("47494638396120000a00", "hex");
const WEBP_X = Buffer.from("524946460000000057454250565038580a00000000000000ff0100df0000", "hex");
const BELL = String.fromCharCode(7);

describe("what a chat file is", () => {
  it("reads the kind from the bytes, refuses programs, and keeps text as text", async () => {
    const { sniffChatFile } = await import("./files");
    expect(sniffChatFile(PNG)).toBe("image/png");
    expect(sniffChatFile(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffChatFile(Buffer.from("504b0304140000", "hex"))).toBe("application/zip");
    expect(sniffChatFile(Buffer.from("id,name\n1,Ann\n"))).toBe("text/plain");
    // HTML and SVG are shown as the text they are, never drawn.
    expect(sniffChatFile(Buffer.from("<svg onload=alert(1)>"))).toBe("text/plain");
    expect(sniffChatFile(Buffer.from("città è già\n"))).toBe("text/plain");
    expect(sniffChatFile(Buffer.from([0, 1, 2, 3, 250]))).toBe("application/octet-stream");
    for (const program of [Buffer.from([0x4d, 0x5a, 0x90, 0]), Buffer.from("7f454c46", "hex"), Buffer.from("cffaedfe", "hex"), Buffer.from("#!/bin/sh\nrm -rf /")]) expect(sniffChatFile(program)).toBeNull();
  });

  it("reads a picture's size from its header", async () => {
    const { imageSize } = await import("./files");
    expect(imageSize(PNG, "image/png")).toEqual({ width: 640, height: 360 });
    expect(imageSize(JPEG, "image/jpeg")).toEqual({ width: 500, height: 300 });
    expect(imageSize(GIF, "image/gif")).toEqual({ width: 32, height: 10 });
    expect(imageSize(WEBP_X, "image/webp")).toEqual({ width: 512, height: 224 });
    expect(imageSize(Buffer.from("89504e47", "hex"), "image/png")).toBeNull();
  });

  it("keeps a name to read, not to obey", async () => {
    const { cleanName } = await import("./files");
    expect(cleanName("../../etc/passwd", "file")).toBe("passwd");
    expect(cleanName("C:" + "\\" + "x" + "\\" + "report" + BELL + ".pdf", "file")).toBe("report.pdf");
    expect(cleanName("   ", "file")).toBe("file");
  });
});

describe("files and publishing, between members", () => {
  let app: typeof import("../boot").default;
  let ann: number, bob: number, cy: number, thread: number;
  const cookies = new Map<number, string>();

  async function login(id: number) {
    const { createHash, randomBytes } = await import("node:crypto");
    const token = randomBytes(32).toString("base64url");
    await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", createHash("sha256").update(token).digest("hex"), id, Date.now() + 3_600_000, Date.now());
    const { sessionCookie } = await import("../lib/session");
    cookies.set(id, sessionCookie(new Request("http://localhost/"), token, 3600).split(";")[0]);
  }
  const writeHeaders = (id: number) => ({ cookie: cookies.get(id)!, origin: "http://localhost", "sec-fetch-site": "same-origin" });
  const upload = (id: number, threadId: number, name: string, bytes: Buffer) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name));
    return app.request(`http://localhost/api/chat/${threadId}/files`, { method: "POST", body: form, headers: writeHeaders(id) });
  };
  const get = (id: number, fileId: number, download = false) => app.request(`http://localhost/api/chat/files/${fileId}${download ? "?download=1" : ""}`, { headers: { cookie: cookies.get(id)! } });
  async function as(id: number) {
    const { userById } = await import("../queries/accounts");
    const { appRouter } = await import("../router");
    return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: (await userById(id)) ?? null, sessionId: null });
  }

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    app = (await import("../boot")).default;
    const mk = async (name: string) => (await one<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES (?, ?, 'member', 1) RETURNING id", name.toLowerCase(), name)).id;
    ann = await mk("Ann");
    bob = await mk("Bob");
    cy = await mk("Cy");
    for (const u of [ann, bob]) await q("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://jira.example', ?, '{}', 'x', 1)", u, "a" + u);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) SELECT ?, id, '10001', 'APP-1', 'Fix', 'Open', 'APP', 'P', 'u', 1 FROM connections WHERE user_id = ?", bob, bob);
    thread = (await one<{ id: number }>("INSERT INTO chat_threads (created_by, tracker_type, tracker_base, issue_remote_id, issue_key, created_at, last_message_at) VALUES (?, 'jira', 'https://jira.example', '10001', 'APP-1', 1, 1) RETURNING id", ann)).id;
    for (const u of [ann, bob]) await q("INSERT INTO chat_members (thread_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)", thread, u);
    for (const u of [ann, bob, cy]) await login(u);
  });

  it("an upload is the uploader's until sent; then every member's; never anyone else's", async () => {
    const res = await upload(ann, thread, "shot.png", PNG);
    expect(res.status).toBe(200);
    const f = (await res.json()) as { id: number; contentType: string; width: number; height: number; name: string };
    expect(f).toMatchObject({ contentType: "image/png", width: 640, height: 360, name: "shot.png" });
    // Sealed at rest: the bytes in the row are not the picture.
    const [row] = await q<{ data: Uint8Array }>("SELECT data FROM chat_files WHERE id = ?", f.id);
    expect(Buffer.from(row.data).includes(PNG.subarray(0, 8))).toBe(false);
    expect((await get(ann, f.id)).status).toBe(200);
    expect((await get(bob, f.id)).status).toBe(404);
    expect((await get(cy, f.id)).status).toBe(404);
    await (await as(ann)).chat.send({ threadId: thread, body: "look", fileIds: [f.id], clientNonce: "nonce-file-1" });
    const seen = await get(bob, f.id);
    expect(seen.status).toBe(200);
    expect(seen.headers.get("content-type")).toBe("image/png");
    expect(seen.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await seen.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await get(bob, f.id, true)).headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await get(cy, f.id)).status).toBe(404);
  });

  it("serves text as sandboxed text and anything unknown as a download", async () => {
    const html = (await (await upload(ann, thread, "x.html", Buffer.from("<script>alert(1)</script>"))).json()) as { id: number };
    const r = await get(ann, html.id);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toMatch(/sandbox/);
    const bin = (await (await upload(ann, thread, "x.bin", Buffer.from([0, 1, 2, 250]))).json()) as { id: number };
    const b = await get(ann, bin.id);
    expect(b.headers.get("content-type")).toBe("application/octet-stream");
    expect(b.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("refuses programs, files over the limit, and non-members", async () => {
    expect((await upload(ann, thread, "setup.exe", Buffer.from([0x4d, 0x5a, 0x90, 0, 3]))).status).toBe(415);
    const { CHAT_FILE_MAX_BYTES } = await import("@contracts/chat");
    expect((await upload(ann, thread, "big.txt", Buffer.alloc(CHAT_FILE_MAX_BYTES + 1, 97))).status).toBe(413);
    // Past the server's 1 MB for ordinary requests, within the chat's own limit: taken.
    expect((await upload(ann, thread, "log.txt", Buffer.alloc(2 * 1024 * 1024, 97))).status).toBe(200);
    expect((await upload(cy, thread, "a.txt", Buffer.from("hi"))).status).toBe(404);
  });

  it("a file not sent can be taken back by its uploader only", async () => {
    const f = (await (await upload(ann, thread, "a.txt", Buffer.from("hi"))).json()) as { id: number };
    const del = (id: number) => app.request(`http://localhost/api/chat/files/${f.id}`, { method: "DELETE", headers: writeHeaders(id) });
    expect((await del(bob)).status).toBe(404);
    expect((await del(ann)).status).toBe(200);
    expect(await q("SELECT id FROM chat_files WHERE id = ?", f.id)).toEqual([]);
  });

  it("publishes a message once, as the caller; someone else's is quoted with their name", async () => {
    const mine = await (await as(bob)).chat.send({ threadId: thread, body: "The export drops **VAT**.", clientNonce: "nonce-pub-1" });
    await (await as(bob)).chat.publish({ messageId: mine.id });
    expect(comments.at(-1)).toMatchObject({ key: "APP-1", text: "The export drops **VAT**." });
    expect(await (await as(bob)).chat.publish({ messageId: mine.id }).catch((e: { code: string }) => e.code)).toBe("CONFLICT");
    const theirs = await (await as(ann)).chat.send({ threadId: thread, body: "Confirmed\nby the analysis", clientNonce: "nonce-pub-2" });
    await (await as(bob)).chat.publish({ messageId: theirs.id });
    expect(comments.at(-1)?.text).toBe("Ann wrote in the chat:\n\n> Confirmed\n> by the analysis");
    const page = await (await as(ann)).chat.messages({ threadId: thread });
    expect(page.messages.find((m) => m.id === mine.id)?.jiraCommentId).toBe("c-1");
    expect(page.messages.filter((m) => m.system?.kind === "published")).toHaveLength(2);
    // Someone with no connection to the tracker can't publish (and nothing is claimed).
    await q("INSERT INTO chat_members (thread_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)", thread, cy);
    const third = await (await as(ann)).chat.send({ threadId: thread, body: "third", clientNonce: "nonce-pub-3" });
    expect(await (await as(cy)).chat.publish({ messageId: third.id }).catch((e: Error) => e.message)).toMatch(/no connection/);
    expect((await (await as(ann)).chat.messages({ threadId: thread })).messages.find((m) => m.id === third.id)?.jiraCommentId).toBeNull();
  });

  it("a tracker failure leaves the message unpublished, to try again", async () => {
    const m = await (await as(bob)).chat.send({ threadId: thread, body: "retry me", clientNonce: "nonce-pub-4" });
    fail.next = true;
    await expect((await as(bob)).chat.publish({ messageId: m.id })).rejects.toThrow(/tracker down/);
    expect((await (await as(bob)).chat.messages({ threadId: thread })).messages.find((x) => x.id === m.id)?.jiraCommentId).toBeNull();
    await (await as(bob)).chat.publish({ messageId: m.id });
    expect(comments.at(-1)?.text).toBe("retry me");
  });

  it("draws Markdown as a rich-text tree", async () => {
    const m = await (await as(ann)).chat.send({ threadId: thread, body: "**bold** and `code`", clientNonce: "nonce-doc-1" });
    expect(m.doc?.blocks.length).toBeGreaterThan(0);
    expect(JSON.stringify(m.doc)).toContain("bold");
  });
});
