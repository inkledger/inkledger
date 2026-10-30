// Pictures in ideas (contracts/ideaFiles.ts): only pictures, read from their bytes,
// only the owner's, and to an agent through a signed link revoked with the others.
import { jiraSignIn } from "./testing/signIn";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));
const SITE = "https://pics.atlassian.net";
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) =>
    String(input).endsWith("/rest/api/3/myself")
      ? new Response(JSON.stringify({ accountId: "acc-p", displayName: "P" }), { headers: { "Content-Type": "application/json" } })
      : new Response("{}", { status: 500 })
  )
);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("idea pictures", () => {
  let cookie = "";
  let userId = 0;
  let app: typeof import("./boot").default;
  let caller: ReturnType<typeof import("./router").appRouter.createCaller>;

  const upload = (ideaId: number, bytes: Uint8Array, name = "shot.png", type = "image/png") => {
    const form = new FormData();
    form.append("file", new File([bytes], name, { type }));
    return app.request(`/api/ideas/${ideaId}/files`, { method: "POST", body: form, headers: { cookie } });
  };

  beforeAll(async () => {
    await (await import("./queries/connection")).resetDbForTests();
    const { appRouter } = await import("./router");
    app = (await import("./boot")).default;
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "p@x.it", secret: "t" });
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("./context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    userId = ctx.user!.id;
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });

  it("a picture goes in, comes back to its owner only, as what its bytes say", async () => {
    const [idea] = await caller.ideas.capture({ text: "Scanner view" });
    const res = await upload(idea.id, PNG, "screen shot.png", "application/octet-stream");
    expect(res.status).toBe(200);
    const made = (await res.json()) as { id: number; markdown: string };
    expect(made.markdown).toBe(`![screen shot.png](idea-file:${made.id})`);
    const got = await app.request(`/api/ideas/files/${made.id}`, { headers: { cookie } });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    // Stored sealed, never as given.
    const { q } = await import("./queries/connection");
    const [row] = await q<{ data: Buffer }>("SELECT data FROM idea_files WHERE id = ?", made.id);
    expect(Buffer.from(row.data).includes(Buffer.from(PNG))).toBe(false);
    expect((await app.request(`/api/ideas/files/${made.id}`)).status).toBe(401);
  });

  it("refuses what isn't a picture (whatever it claims), too big, and other people's ideas and files", async () => {
    const [idea] = await caller.ideas.capture({ text: "Refusals" });
    expect((await upload(idea.id, new TextEncoder().encode("<svg onload=alert(1)>"), "x.png", "image/png")).status).toBe(415);
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(PNG);
    expect((await upload(idea.id, big)).status).toBe(413);
    const { q } = await import("./queries/connection");
    const [{ id: other }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('other-pics', 'O', 1) RETURNING id");
    const [{ id: theirIdea }] = await q<{ id: number }>("INSERT INTO ideas (user_id, title, created_at, updated_at) VALUES (?, 'theirs', 1, 1) RETURNING id", other);
    expect((await upload(theirIdea, PNG)).status).toBe(404);
    const [{ id: theirFile }] = await q<{ id: number }>(
      "INSERT INTO idea_files (user_id, idea_id, name, content_type, size, data, created_at) VALUES (?, ?, 'x.png', 'image/png', 1, ?, 1) RETURNING id",
      other, theirIdea, Buffer.from([1])
    );
    expect((await app.request(`/api/ideas/files/${theirFile}`, { headers: { cookie } })).status).toBe(404);
    expect(userId).toBeGreaterThan(0);
  });

  it("handed to an agent: signed links that open without a session, until revoked; the text is drawn with its picture", async () => {
    const [idea] = await caller.ideas.capture({ text: "Handoff" });
    const made = (await (await upload(idea.id, PNG)).json()) as { id: number; markdown: string };
    await caller.ideas.update({ id: idea.id, body: `Look:\n\n${made.markdown}` });
    const got = await caller.ideas.get({ id: idea.id });
    expect(JSON.stringify(got.doc)).toContain(`idea-file:${made.id}`);
    const h = await caller.ideas.handoff({ id: idea.id });
    const link = /http:\/\/localhost\/api\/shared\/[\w.-]+/.exec(h.markdown)?.[0];
    expect(link).toBeTruthy();
    expect(h.markdown).not.toContain("idea-file:");
    const shared = await app.request(new URL(link!).pathname);
    expect(shared.status).toBe(200);
    expect(shared.headers.get("content-disposition")).toMatch(/^attachment/);
    await caller.settings.revokeShareLinks();
    expect((await app.request(new URL(link!).pathname)).status).not.toBe(200);
  });
});
