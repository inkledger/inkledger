// The Desk's chat (docs/work/desk.md, batch 4c): the issues shown on the desk as the
// model's context (the user's own only), and POST /api/desk/chat streaming the answer.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jiraSignIn } from "../testing/signIn";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

/** What the fake Ollama does with the next /api/chat call; trackers always fail (no description). */
let ollama: (init: RequestInit | undefined) => Response = () => new Response(null, { status: 500 });
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/chat")) return ollama(init);
    if (url.includes("/myself")) return new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ errorMessages: ["unexpected call"] }), { status: 500 });
  }),
);

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const { env } = await import("../lib/env");
const saved = { url: env.ollamaUrl, sim: env.ollamaSimulator };
afterEach(() => {
  env.ollamaUrl = saved.url;
  env.ollamaSimulator = saved.sim;
  ollama = () => new Response(null, { status: 500 });
});

describe("the desk's chat", () => {
  let app: typeof import("../boot").default;
  let cookie = "";
  let user: import("@db/schema").User;
  let conn = 0;
  let bobConn = 0;
  const pane = (key: string, connectionId = conn) => ({ connectionId, key, remoteId: null });

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    app = (await import("../boot")).default;
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    user = (await userFromRequest(new Request("http://localhost/", { headers: { cookie } }))).user!;
    conn = (await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ?", user.id))[0].id;
    const [bob] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('bob', 'Bob', 1) RETURNING id");
    bobConn = (
      await q<{ id: number }>(
        "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://x.atlassian.net', 'me', ?, 'x', 1) RETURNING id",
        bob.id,
        JSON.stringify({ deployment: "cloud", authType: "basic", username: "me@x.it" }),
      )
    )[0].id;
    const issue = (userId: number, connectionId: number, key: string, summary: string) =>
      q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, ?, 'To Do', 'APP', 'App', 'https://acme.atlassian.net/browse/' || ?, 1)", userId, connectionId, key, key, summary, key);
    await issue(user.id, conn, "APP-1", "Login fails on Safari");
    await issue(user.id, conn, "APP-2", "Slow search");
    await issue(user.id, conn, "APP-3", "Parked one");
    await issue(bob.id, bobConn, "BOB-1", "Bob's secret");
  });

  describe("deskChatContext", () => {
    it("the issues shown, in order: empty slots and parked issues left out", async () => {
      const { deskChatContext } = await import("./chat");
      const ctx = await deskChatContext(user, { panes: [pane("APP-2"), { empty: true, id: "1" }, pane("APP-1")], parked: [pane("APP-3")] }, { origin: "http://localhost" });
      expect(ctx.issues.map(i => i.key)).toEqual(["APP-2", "APP-1"]);
      expect(ctx.issues[0]).toMatchObject({ connectionId: conn, title: "Slow search" });
      expect(ctx.markdown).toContain("APP-2: Slow search");
      expect(ctx.markdown).toContain("APP-1: Login fails on Safari");
      expect(ctx.markdown).not.toContain("APP-3");
    });

    it("another user's issue is refused, by its connection or by its key", async () => {
      const { deskChatContext } = await import("./chat");
      await expect(deskChatContext(user, { panes: [pane("APP-1"), pane("BOB-1", bobConn)] }, { origin: "http://localhost" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(deskChatContext(user, { panes: [pane("BOB-1")] }, { origin: "http://localhost" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("POST /api/desk/chat", () => {
    const ask = (body: unknown, headers: Record<string, string> = { cookie }) =>
      app.request("/api/desk/chat", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    // Built when asked: the connection exists only once beforeAll has run.
    const question = () => ({ panes: [pane("APP-1"), pane("APP-2")], messages: [{ role: "user", content: "Compare these issues" }] });
    const readAll = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

    it("needs a session, and the user's own issues", async () => {
      expect((await ask(question(), {})).status).toBe(401);
      env.ollamaSimulator = "1";
      const res = await ask({ ...question(), panes: [pane("BOB-1", bobConn)] });
      expect(res.status).toBe(404);
      expect(await readAll(res)).not.toContain("secret");
    });

    it("the model off: one `off` event saying why, never an error", async () => {
      env.ollamaSimulator = null;
      env.ollamaUrl = null;
      const res = await ask(question());
      expect(res.status).toBe(200);
      const text = await readAll(res);
      expect(text).toContain("event: off");
      expect(text).not.toContain("event: delta");
    });

    it("streams the simulated answer: the context first, pieces, then the whole answer as a document", async () => {
      env.ollamaSimulator = "1";
      const res = await ask(question());
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await readAll(res);
      expect(text.indexOf("event: context")).toBeLessThan(text.indexOf("event: delta"));
      expect(text.match(/event: delta/g)!.length).toBeGreaterThan(5);
      expect(text).toContain("event: done");
      const done = JSON.parse(/event: done\ndata: (.*)\n/.exec(text)![1]) as { markdown: string; doc: { blocks: unknown[] } };
      expect(done.markdown).toContain("APP-1");
      expect(done.markdown).toContain("APP-2");
      expect(done.doc.blocks.length).toBeGreaterThan(1);
    });

    it("refuses a conversation that doesn't end with the user's question", async () => {
      env.ollamaSimulator = "1";
      expect((await ask({ ...question(), messages: [{ role: "assistant", content: "hi" }] })).status).toBe(400);
      expect((await ask({ ...question(), messages: [] })).status).toBe(400);
    });

    it("asks Ollama with the issues and the conversation, and aborts it when the client goes away", async () => {
      env.ollamaSimulator = null;
      env.ollamaUrl = "http://127.0.0.1:11434";
      let upstream: AbortSignal | undefined;
      let sent: { messages: { role: string; content: string }[]; stream: boolean } | undefined;
      ollama = init => {
        upstream = init?.signal ?? undefined;
        sent = JSON.parse(String(init?.body)) as typeof sent;
        // One piece, then nothing more until aborted.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: "Partial" }, done: false })}\n`));
            },
          }),
        );
      };
      const res = await ask({ ...question(), messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }, { role: "user", content: "Which first?" }] });
      const reader = res.body!.getReader();
      let got = "";
      while (!got.includes("Partial")) {
        const { value, done } = await reader.read();
        if (done) break;
        got += new TextDecoder().decode(value);
      }
      expect(got).toContain("event: context");
      expect(sent?.stream).toBe(true);
      expect(sent?.messages.map(m => m.role)).toEqual(["system", "user", "assistant", "user"]);
      expect(sent?.messages[0].content).toContain("APP-1: Login fails on Safari");
      expect(upstream?.aborted).toBe(false);
      await reader.cancel();
      await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
    });
  });

  describe("tools (batch 4d): the page runs them, the server only forwards", () => {
    const ask = (body: unknown) => app.request("/api/desk/chat", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    const readAll = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());
    const events = (text: string) => [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m => ({ event: m[1], data: JSON.parse(m[2]) as Record<string, unknown> }));
    const question = { role: "user", content: "Is APP-1 solved? Look at the code" };
    const call = { role: "assistant", content: "", tool_calls: [{ name: "grep", arguments: { repo: "app", query: "APP-1" } }] };
    const result = { role: "tool", name: "grep", content: "src/Login.kt:12: // APP-1 fixed" };
    const body = (messages: unknown[], extra: Record<string, unknown> = {}) => ({ panes: [pane("APP-1")], messages, tools: ["grep", "read"], repos: ["app"], ...extra });

    it("validates tool turns: known tools, a result only after a call, sizes capped", async () => {
      env.ollamaSimulator = "1";
      const bad = [
        body([question, { ...call, tool_calls: [{ name: "bash", arguments: { cmd: "ls" } }] }, result]),
        body([question, result]),
        body([question, call, { ...result, content: "x".repeat(20_000) }]),
        body([question, call, result], { tools: ["write"] }),
        body([question, call, result, result]),
        body([question, { ...call, tool_calls: [{ name: "grep", arguments: { query: "y".repeat(5_000) } }] }, result]),
        body([question, call]),
        body([question], { repos: ["/Users/me/secret"] }),
      ];
      for (const b of bad) expect((await ask(b)).status, JSON.stringify(b).slice(0, 200)).toBe(400);
      expect((await ask(body([question, call, result]))).status).toBe(200);
    });

    it("forwards the tools offered and the turns to Ollama; tool calls come back as an event", async () => {
      env.ollamaSimulator = null;
      env.ollamaUrl = "http://127.0.0.1:11434";
      let sent: { tools?: { function: { name: string; parameters: unknown } }[]; messages: Record<string, unknown>[]; model: string } | undefined;
      ollama = init => {
        sent = JSON.parse(String(init?.body)) as typeof sent;
        return new Response(
          `${JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { repo: "app", path: "src/Login.kt" } } }] }, done: false })}\n${JSON.stringify({ message: { content: "" }, done: true })}\n`,
        );
      };
      const text = await readAll(await ask(body([question, call, result])));
      expect(sent?.tools?.map(t => t.function.name)).toEqual(["grep", "read"]);
      // The repositories are context, not part of the tools' schemas.
      expect(JSON.stringify(sent?.tools)).not.toContain('"app"');
      expect(sent?.messages.map(m => m.role)).toEqual(["system", "user", "assistant", "tool"]);
      expect(sent?.messages[2]).toMatchObject({ tool_calls: [{ function: { name: "grep", arguments: { repo: "app", query: "APP-1" } } }] });
      expect(sent?.messages[3]).toEqual({ role: "tool", tool_name: "grep", content: "src/Login.kt:12: // APP-1 fixed" });
      expect(String(sent?.messages[0].content)).toContain("app");
      expect(String(sent?.messages[0].content)).toMatch(/exactly/);
      const tc = events(text).find(e => e.event === "tool_calls");
      expect(tc?.data).toEqual({ calls: [{ name: "read", arguments: { repo: "app", path: "src/Login.kt" } }] });
      expect(text).not.toContain("event: done");
    });

    it("the chat model is OLLAMA_CHAT_MODEL; a model without tools gets none", async () => {
      env.ollamaSimulator = null;
      env.ollamaUrl = "http://127.0.0.1:11434";
      const savedModel = env.ollamaChatModel;
      env.ollamaChatModel = "qwen3:8b";
      let sent: { model: string; tools?: unknown[] } | undefined;
      ollama = init => {
        sent = JSON.parse(String(init?.body)) as typeof sent;
        return new Response(`${JSON.stringify({ message: { content: "Hi" }, done: true })}\n`);
      };
      await readAll(await ask(body([question], { tools: [] })));
      expect(sent?.model).toBe("qwen3:8b");
      expect(sent?.tools).toBeUndefined();
      env.ollamaChatModel = savedModel;
    });

    it("after twelve rounds no tools go to the model, which is told to answer", async () => {
      env.ollamaSimulator = null;
      env.ollamaUrl = "http://127.0.0.1:11434";
      let sent: { tools?: unknown[]; messages: { role: string; content: string }[] } | undefined;
      ollama = init => {
        sent = JSON.parse(String(init?.body)) as typeof sent;
        return new Response(`${JSON.stringify({ message: { content: "Done" }, done: true })}\n`);
      };
      const rounds = (n: number) => Array.from({ length: n }, () => [call, result]).flat();
      await readAll(await ask(body([question, ...rounds(12)])));
      expect(sent?.tools).toBeUndefined();
      expect(sent?.messages.at(-1)?.content).toMatch(/answer now/i);
      expect((await ask(body([question, ...rounds(13)]))).status).toBe(400);
    });

    it("the simulator plays a scripted round: grep for the first key, then an answer citing the result", async () => {
      env.ollamaSimulator = "1";
      const first = events(await readAll(await ask(body([question]))));
      expect(first.find(e => e.event === "tool_calls")?.data).toEqual({ calls: [{ name: "grep", arguments: { repo: "app", query: "APP-1" } }] });
      const second = events(await readAll(await ask(body([question, call, result]))));
      const done = second.find(e => e.event === "done")?.data as { markdown: string } | undefined;
      expect(done?.markdown).toContain("src/Login.kt:12");
      expect(done?.markdown).toContain("APP-1");
    });

    it("extracts (a model without tools) go in with the question", async () => {
      env.ollamaSimulator = "notools";
      const res = await ask(body([question], { tools: [], extracts: '### grep "APP-1" in app\nsrc/Login.kt:12: // APP-1 fixed' }));
      const done = events(await readAll(res)).find(e => e.event === "done")?.data as { markdown: string } | undefined;
      expect(done?.markdown).toContain("src/Login.kt:12");
    });

    it("questions and tool rounds are counted apart: a round never uses up a question", async () => {
      env.ollamaSimulator = "1";
      for (let i = 0; i < 20; i++) expect((await ask(body([question, call, result]))).status).toBe(200);
    });

    it("never touches the file system, whatever paths the turns carry", async () => {
      env.ollamaSimulator = "1";
      const { syncBuiltinESMExports } = await import("node:module");
      const fs = (await import("node:fs")).default;
      const names = ["readFileSync", "readdirSync", "statSync", "lstatSync", "openSync", "existsSync", "realpathSync", "createReadStream", "readFile", "readdir", "stat", "lstat", "open", "opendir"] as const;
      const promised = ["readFile", "readdir", "stat", "lstat", "open", "realpath", "opendir"] as const;
      const spies = [...names.map(n => vi.spyOn(fs, n)), ...promised.map(n => vi.spyOn(fs.promises, n))];
      syncBuiltinESMExports();
      try {
        // The spies see a read made through the named ESM exports too.
        (await import("node:fs")).statSync(".");
        expect(spies[names.indexOf("statSync")].mock.calls).toHaveLength(1);
        for (const s of spies) s.mockClear();
        const sneaky = { role: "assistant", content: "", tool_calls: [{ name: "read", arguments: { repo: "app", path: "/etc/passwd" } }] };
        const text = await readAll(await ask(body([question, sneaky, { role: "tool", name: "read", content: "error" }], { repos: ["app", "etc"] })));
        expect(text).toContain("event: done");
        for (const s of spies) expect(s.mock.calls, s.getMockName()).toEqual([]);
      } finally {
        for (const s of spies) s.mockRestore();
        syncBuiltinESMExports();
      }
    });
  });

  it("the chat's own modules import no file system or process API", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["api/desk/chat.ts", "api/ai/ollama.ts", "api/ai/prompts/deskChat.ts", "contracts/codeTools.ts", "contracts/deskChat.ts"]) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/from "(node:)?(fs|fs\/promises|child_process|path)"/);
    }
  });

  describe("POST /api/desk/chat/reach", () => {
    const reach = (panes: unknown[]) => app.request("/api/desk/chat/reach", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ panes }) });
    it("the projects of the issues shown with their repository paths, and whether the model can use tools", async () => {
      env.ollamaSimulator = "1";
      const [c] = await q<{ id: number }>("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (?, 'app', 'APP', 'App', 1) RETURNING id", conn);
      await q("UPDATE issues SET container_id = ? WHERE key IN ('APP-1', 'APP-2')", c.id);
      await q("INSERT INTO container_paths (user_id, container_id, label, path, position) VALUES (?, ?, 'app', '~/code/app', 0)", user.id, c.id);
      const res = await reach([pane("APP-1"), pane("APP-2"), pane("BOB-1", bobConn)]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        model: { on: true, tools: true },
        projects: [{ containerId: c.id, key: "APP", name: "App", repos: [{ label: "app", path: "~/code/app" }] }],
        issues: [
          { key: "APP-1", title: "Login fails on Safari" },
          { key: "APP-2", title: "Slow search" },
        ],
      });
      env.ollamaSimulator = "notools";
      expect(((await (await reach([pane("APP-1")])).json()) as { model: unknown }).model).toEqual({ on: true, tools: false });
      env.ollamaSimulator = null;
      env.ollamaUrl = null;
      expect(((await (await reach([pane("APP-1")])).json()) as { model: unknown }).model).toEqual({ on: false, tools: false });
    });
  });
});
