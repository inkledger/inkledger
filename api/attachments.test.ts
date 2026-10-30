import { jiraSignIn } from "./testing/signIn";
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.endsWith("/rest/api/3/myself")) {
    return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: { "48x48": `${SITE}/avatar/acc-1.png` } });
  }
  if (url === `${SITE}/avatar/acc-1.png`) {
    return new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } });
  }
  if (url.includes("/issue/PRJ-1/comment") && method === "GET") {
    return json({
      comments: [
        {
          id: "10",
          author: { displayName: "Mario", accountId: "acc-1" },
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Ciao" }] }] },
          created: "2026-10-15T10:00:00.000+0200",
        },
      ],
    });
  }
  if (url.includes("/issue/PRJ-1/comment") && method === "POST") return json({ id: "11", created: "x" }, 201);
  if (url.includes("/issue/PRJ-1?fields=description")) {
    return json({
      fields: {
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "To Do" }] }] },
      },
    });
  }
  if (url.includes("/issue/PRJ-1?fields=attachment")) {
    return json({
      fields: {
        attachment: [
          { id: "77", filename: "screen.png", mimeType: "image/png", size: 10, thumbnail: `${SITE}/thumb/77` },
        ],
      },
    });
  }
  if (url.endsWith("/attachment/77")) {
    return json({ id: "77", filename: "screen.png", mimeType: "image/png", content: `${SITE}/content/77` });
  }
  if (url.endsWith("/attachment/66")) {
    return json({ id: "66", filename: "evil.png", mimeType: "image/png", content: "https://evil.example/x" });
  }
  if (url === `${SITE}/content/77`) {
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  }
  if (url.includes("/issue/PRJ-1/attachments") && method === "POST") {
    return json([{ id: "88", filename: "note.txt" }]);
  }
  if (url.includes("/issue/PRJ-2/attachments") && method === "POST") {
    return json({ errorMessages: ["You are not allowed to attach files"] }, 403);
  }
  return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
});

describe("Jira comments and attachments", () => {
  let cookie = "";
  let app: typeof import("./boot").default;
  let caller: ReturnType<typeof import("./router").appRouter.createCaller>;

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchMock);
    const conn = await import("./queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("./router");
    app = (await import("./boot")).default;
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("./context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    expect(ctx.user).not.toBeNull();
    caller = appRouter.createCaller({
      req: new Request("http://localhost/"),
      resHeaders: new Headers(),
      user: ctx.user,
      sessionId: ctx.sessionId,
    });
  });

  afterEach(() => fetchMock.mockClear());

  it("lists comments as plain text and adds a new one", async () => {
    const list = await caller.issues.comments({ key: "PRJ-1" });
    expect(list).toEqual([expect.objectContaining({ id: "10", author: "Mario", body: "Ciao", isMine: true })]);
    await caller.issues.addComment({ key: "PRJ-1", text: "New" });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body)).body.type).toBe("doc");
  });

  it("returns the issue description as text", async () => {
    expect(await caller.issues.description({ key: "PRJ-1" })).toMatchObject({ text: "To Do" });
  });

  it("lists attachment metadata", async () => {
    const list = await caller.issues.attachments({ key: "PRJ-1" });
    expect(list[0]).toMatchObject({ id: "77", filename: "screen.png", hasThumbnail: true });
  });

  it("serves the user's Jira avatar through the server", async () => {
    expect((await app.request("/api/me/avatar")).status).toBe(401);
    const res = await app.request("/api/me/avatar", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("rejects attachment downloads without a session", async () => {
    const res = await app.request("/api/attachments/77/content");
    expect(res.status).toBe(401);
  });

  it("streams an attachment from the user's Jira site", async () => {
    const res = await app.request("/api/attachments/77/content", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(137);
  });

  it("never fetches attachment URLs outside the Jira site", async () => {
    const res = await app.request("/api/attachments/66/content", { headers: { cookie } });
    expect(res.status).not.toBe(200);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("https://evil.example"))).toBe(false);
  });

  it("a shared link downloads without a session", async () => {
    const { q } = await import("./queries/connection");
    const [{ id: connId, user_id: userId }] = await q<{ id: number; user_id: number }>("SELECT id, user_id FROM connections ORDER BY id LIMIT 1");
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, issue_type, project_key, project_name, url, synced_at) VALUES (?, ?, '1', 'PRJ-1', 'Export fails', 'To Do', 'Bug', 'PRJ', 'Project', ?, 1) ON CONFLICT DO NOTHING",
      userId, connId, `${SITE}/browse/PRJ-1`,
    );
    const { markdown, expiresAt } = await caller.issues.copyForAgent({ key: "PRJ-1", minutes: 60 });
    expect(markdown).toContain("# PRJ-1: Export fails");
    expect(markdown).toContain(`- Tracker: ${SITE}/browse/PRJ-1`);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    const link = /\[screen\.png\]\((http:\/\/localhost\/api\/shared\/[^)]+)\)/.exec(markdown)?.[1];
    expect(link).toBeDefined();
    // No cookie: the token is the only credential.
    const res = await app.request(new URL(link!).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(137);
  });

  it("revoked and orphaned links are not found", async () => {
    const link = (md: string) => new URL(/\((http:\/\/localhost\/api\/shared\/[^)]+)\)/.exec(md)![1]).pathname;
    const before = link((await caller.issues.copyForAgent({ key: "PRJ-1" })).markdown);
    expect((await app.request(before)).status).toBe(200);
    await caller.settings.revokeShareLinks();
    const revoked = await app.request(before);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe("");
    // A new copy works again; then its connection is archived.
    const after = link((await caller.issues.copyForAgent({ key: "PRJ-1" })).markdown);
    expect((await app.request(after)).status).toBe(200);
    const { q } = await import("./queries/connection");
    await q("UPDATE connections SET archived_at = 1");
    expect((await app.request(after)).status).toBe(404);
    await q("UPDATE connections SET archived_at = NULL");
    expect((await app.request("/api/shared/not-a-token")).status).toBe(404);
  });

  it("uploads files as multipart with the XSRF opt-out header", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const res = await app.request("/api/issues/PRJ-1/attachments", { method: "POST", body: form, headers: { cookie } });
    expect(res.status).toBe(200);
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/attachments"));
    const init = call?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Atlassian-Token")).toBe("no-check");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("reports a refused upload as 403, not as a missing attachment", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const res = await app.request("/api/issues/PRJ-2/attachments", { method: "POST", body: form, headers: { cookie } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).not.toMatch(/Attachment not found/);
  });

  it("keeps the read-only guard message on uploads", async () => {
    const { uploadErrorResponse } = await import("./attachments");
    const { JiraApiError } = await import("./jira/client");
    const msg = "Jira in sola lettura (JIRA_READ_ONLY): POST bloccato";
    expect(uploadErrorResponse(new JiraApiError(403, msg))).toEqual({ status: 403, message: msg });
  });

  it("rejects uploads with an invalid issue key", async () => {
    const res = await app.request("/api/issues/bad key/attachments", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(400);
  });
});

describe("attachment headers", () => {
  it("previews images, PDF and text inline; everything else downloads", async () => {
    const { attachmentHeaders } = await import("./attachments");
    const pdf = attachmentHeaders("application/pdf", "offerta.pdf");
    expect(pdf.get("content-type")).toBe("application/pdf");
    expect(pdf.get("content-disposition")).toMatch(/^inline/);
    expect(pdf.get("content-security-policy")).not.toMatch(/sandbox/); // the PDF viewer needs it off
    expect(pdf.get("content-security-policy")).toMatch(/default-src 'none'/);

    const txt = attachmentHeaders("text/plain; charset=iso-8859-1", "log.txt");
    expect(txt.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(txt.get("content-security-policy")).toMatch(/^sandbox/);

    expect(attachmentHeaders("image/png", "a.png").get("content-disposition")).toMatch(/^inline/);
    for (const t of ["image/svg+xml", "text/html", "application/zip"]) {
      const h = attachmentHeaders(t, "x");
      expect(h.get("content-type"), t).toBe("application/octet-stream");
      expect(h.get("content-disposition"), t).toMatch(/^attachment/);
      expect(h.get("content-security-policy"), t).toMatch(/^sandbox/);
    }
  });
});
