// The Desk chat's agent loop (docs/work/desk.md, batch 4d, the Pi-style harness): one
// state machine for the browser and the app; only the tool executors differ.
import { describe, expect, it } from "vitest";
import type { DeskChatEvent, DeskChatRequest, DeskChatToolCall } from "@contracts/deskChat";
import { MAX_TOOL_ROUNDS } from "@contracts/codeTools";
import { compactWire, extractQueries, formatExtracts, runAgent, type AgentEvent, type AgentWire } from "./agent";

const doc = { v: 1 as const, blocks: [] };
const answer = (markdown: string): DeskChatEvent[] => [
  { event: "delta", data: { text: markdown } },
  { event: "done", data: { markdown, doc } },
];
const calls = (...list: DeskChatToolCall[]): DeskChatEvent[] => [{ event: "tool_calls", data: { calls: list } }];

/** A server that answers each round from a script, keeping what was posted. */
function server(rounds: (body: DeskChatRequest, n: number) => DeskChatEvent[]) {
  const posted: DeskChatRequest[] = [];
  return {
    posted,
    post: async function* (body: DeskChatRequest) {
      posted.push(structuredClone(body));
      yield* rounds(body, posted.length - 1);
    },
  };
}

const base = { history: [], question: "Is MAGA-400 solved?", panes: [], tools: ["grep", "read", "git_log"] as const, repos: ["app"], issues: [{ key: "MAGA-400", title: "Stock goes below zero" }] };

describe("runAgent", () => {
  it("a tool round: the call runs here, its result goes back, then the answer", async () => {
    const s = server((_, n) => (n === 0 ? calls({ name: "grep", arguments: { repo: "app", query: "MAGA-400" } }) : answer("Solved in **MAGA-400**.")));
    const ran: DeskChatToolCall[] = [];
    const events: AgentEvent[] = [];
    const end = await runAgent(
      { ...base, tools: [...base.tools], mode: "tools" },
      {
        post: body => s.post(body),
        runTool: async call => {
          ran.push(call);
          return { ok: true, text: "src/Stock.kt:12: // MAGA-400", brief: 'grep "MAGA-400" in app: 1 hit' };
        },
      },
      e => events.push(e),
    );
    expect(end).toBe("done");
    expect(ran).toEqual([{ name: "grep", arguments: { repo: "app", query: "MAGA-400" } }]);
    expect(s.posted[1].messages.map(m => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(s.posted[1].messages[2]).toEqual({ role: "tool", name: "grep", content: "src/Stock.kt:12: // MAGA-400" });
    expect(s.posted[0].tools).toEqual(["grep", "read", "git_log"]);
    expect(events.filter(e => e.type === "step").map(e => e.type === "step" && e.step.status)).toEqual(["running", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", markdown: "Solved in **MAGA-400**." });
  });

  it("after the last round the model gets no tools and must answer", async () => {
    const s = server((body, n) => (body.tools?.length ? calls({ name: "grep", arguments: { repo: "app", query: `q${n}` } }) : answer("Here is what I found.")));
    const end = await runAgent({ ...base, tools: [...base.tools], mode: "tools" }, { post: body => s.post(body), runTool: async () => ({ ok: true, text: "nothing", brief: "nothing" }) }, () => {});
    expect(end).toBe("done");
    expect(s.posted).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(s.posted.at(-1)?.tools).toEqual([]);
  });

  it("a model that keeps calling tools without any to call ends, never loops", async () => {
    const s = server(() => calls({ name: "grep", arguments: { repo: "app", query: "x" } }));
    const events: AgentEvent[] = [];
    const end = await runAgent({ ...base, tools: [...base.tools], mode: "tools" }, { post: body => s.post(body), runTool: async () => ({ ok: true, text: "x", brief: "x" }) }, e => events.push(e));
    expect(end).toBe("error");
    expect(s.posted.length).toBeLessThanOrEqual(MAX_TOOL_ROUNDS + 1);
  });

  it("Stop between steps: no further round is asked", async () => {
    const stop = new AbortController();
    const s = server(() => calls({ name: "grep", arguments: { repo: "app", query: "x" } }));
    const end = await runAgent(
      { ...base, tools: [...base.tools], mode: "tools" },
      {
        post: body => s.post(body),
        runTool: async () => {
          stop.abort();
          return { ok: true, text: "x", brief: "x" };
        },
      },
      () => {},
      stop.signal,
    );
    expect(end).toBe("stopped");
    expect(s.posted).toHaveLength(1);
  });

  it("a tool that fails tells the model why; it isn't the end", async () => {
    const s = server((_, n) => (n === 0 ? calls({ name: "read", arguments: { repo: "app", path: "../x" } }) : answer("ok")));
    const end = await runAgent({ ...base, tools: [...base.tools], mode: "tools" }, { post: body => s.post(body), runTool: async () => ({ ok: false, text: "error: the path leaves the repository", brief: "read ../x: refused" }) }, () => {});
    expect(end).toBe("done");
    expect(s.posted[1].messages[2]).toMatchObject({ role: "tool", content: "error: the path leaves the repository" });
  });

  it("without tool support: extracts are gathered first and sent with the question", async () => {
    const s = server(() => answer("From the extracts: solved."));
    const asked: string[] = [];
    await runAgent(
      { ...base, tools: [...base.tools], mode: "extracts" },
      {
        post: body => s.post(body),
        runTool: async call => {
          asked.push(`${call.name}:${JSON.stringify(call.arguments)}`);
          return call.name === "grep" && call.arguments.query === "MAGA-400"
            ? { ok: true, text: "src/Stock.kt:12: // MAGA-400 stock", brief: "1 hit" }
            : { ok: true, text: "(no match)", brief: "no match" };
        },
      },
      () => {},
    );
    expect(asked[0]).toBe('grep:{"repo":"app","query":"MAGA-400"}');
    expect(asked).toContain('git_log:{"repo":"app","grep":"MAGA-400","limit":5}');
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0].tools).toEqual([]);
    expect(s.posted[0].extracts).toContain("src/Stock.kt:12: // MAGA-400 stock");
  });
});

describe("compactWire", () => {
  const tool = (n: number, size: number): AgentWire => ({ role: "tool", name: "read", content: "x".repeat(size), brief: `read f${n}.kt lines 1–200` });
  it("under the budget nothing changes", () => {
    const wire: AgentWire[] = [{ role: "user", content: "q" }, tool(1, 100), tool(2, 100)];
    expect(compactWire(wire, 1_000, 2)).toEqual(wire);
  });

  it("over it, old results become their one line; the last few stay whole", () => {
    const wire: AgentWire[] = [{ role: "user", content: "q" }, tool(1, 5_000), tool(2, 5_000), tool(3, 5_000), tool(4, 5_000)];
    const out = compactWire(wire, 12_000, 2);
    expect(out.map(m => (m.role === "tool" ? m.content.length : 0))).toEqual([0, expect.any(Number), expect.any(Number), 5_000, 5_000]);
    expect(out[1]).toMatchObject({ content: "read f1.kt lines 1–200 (elided)" });
    expect(out[2]).toMatchObject({ content: "read f2.kt lines 1–200 (elided)" });
    // The last ones are kept whole even when alone they pass the budget.
    expect(compactWire([tool(1, 9_000), tool(2, 9_000)], 1_000, 2).map(m => m.content.length)).toEqual([9_000, 9_000]);
  });
});

describe("extracts", () => {
  it("queries: each key, then the title's distinctive words", () => {
    expect(extractQueries([{ key: "MAGA-400", title: "Inventario: la giacenza va sotto zero dopo il reso" }])).toEqual(["MAGA-400", "inventario", "giacenza"]);
  });

  it("formatted per query, capped", () => {
    const md = formatExtracts([{ label: 'grep "MAGA-400" in app', text: "src/a.kt:1: MAGA-400" }, { label: "empty", text: "" }], 1_000);
    expect(md).toContain('### grep "MAGA-400" in app\nsrc/a.kt:1: MAGA-400');
    expect(md).not.toContain("empty");
    expect(formatExtracts([{ label: "big", text: "y".repeat(5_000) }], 1_000).length).toBeLessThanOrEqual(1_000);
  });
});
