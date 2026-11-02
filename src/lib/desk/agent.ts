import type { DeskChatEvent, DeskChatIssue, DeskChatRequest, DeskChatToolCall, DeskChatWire } from "@contracts/deskChat";
import type { DeskSlot } from "@contracts/desk";
import type { RichDoc } from "@contracts/richtext";
import { EXTRACTS_CHARS, MAX_TOOL_ROUNDS, TOOL_RESULT_CHARS, capText, type CodeToolName } from "@contracts/codeTools";
import { randomUUID } from "@/lib/randomId";

/**
 * The Desk chat's agent loop (docs/work/desk.md, batch 4d: a Pi-style native harness). One
 * small state machine for the browser and the app: ask the server, which asks the model;
 * when the model wants tools, run them here (`runTool`: the app's Rust commands or a
 * connected folder), append the results and ask again; at most MAX_TOOL_ROUNDS rounds, then
 * the model gets no tools and must answer. Old tool results are compacted to one line each
 * when the conversation nears its budget. With a model that can't call tools, the loop
 * searches the code itself first and sends the extracts with the question.
 */

/** A message of the loop: a tool result also keeps its one-line summary, for compaction. */
export type AgentWire = DeskChatWire | { role: "tool"; name: CodeToolName; content: string; brief: string };

/** A tool step as the conversation shows it. */
export type AgentStep = {
  id: string;
  call: DeskChatToolCall;
  status: "running" | "done" | "failed";
  /** One line: what was asked and what came ("grep "MAGA-400" in app: 3 hits"). */
  brief: string;
  /** What the model read (empty while running). */
  text: string;
};

export type AgentEvent =
  | { type: "context"; issues: DeskChatIssue[] }
  | { type: "delta"; text: string }
  | { type: "draft"; doc: RichDoc }
  /** The text written in a tool round goes into the round, not into the answer. */
  | { type: "reset" }
  | { type: "step"; step: AgentStep }
  | { type: "done"; markdown: string; doc: RichDoc }
  /** Empty: the answer didn't come, said in the page's words. */
  | { type: "error"; message: string }
  | { type: "off"; message: string };

export type ToolRun = { ok: boolean; text: string; brief: string; /** Nothing found (left out of extracts). */ empty?: boolean };

export type AgentDeps = {
  post: (body: DeskChatRequest, signal?: AbortSignal) => AsyncIterable<DeskChatEvent>;
  runTool: (call: DeskChatToolCall, signal?: AbortSignal) => Promise<ToolRun>;
  /** A tool that takes longer is given up on (the model is told). */
  toolTimeoutMs?: number;
  /** Shown while a step runs: its one-line description. */
  describe?: (call: DeskChatToolCall) => string;
};

export type AgentInput = {
  /** The earlier questions and answers (no tool rounds). */
  history: DeskChatWire[];
  question: string;
  panes: readonly DeskSlot[];
  /** The tools the page can run now. */
  tools: CodeToolName[];
  /** The repositories in reach, by label. */
  repos: string[];
  /** The issues shown, for the extracts' queries. */
  issues: { key: string; title: string }[];
  /** The model calls tools; the page searches for it (a model without tools); no code in reach. */
  mode: "tools" | "extracts" | "none";
};

export type AgentEnd = "done" | "stopped" | "error" | "off";

/** Tool results kept whole however long the conversation (the latest). */
export const KEEP_WHOLE = 3;
/** The current question's rounds, in characters, before old results are compacted. */
export const COMPACT_BUDGET = 40_000;
const TOOL_TIMEOUT_MS = 30_000;
/** Queries and repositories the extracts search, at most. */
const EXTRACT_QUERIES = 8;
const EXTRACT_REPOS = 3;

const size = (m: AgentWire) => m.content.length + (m.role === "assistant" && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

/**
 * Old tool results replaced by their one line ("read src/x.kt lines 1–200 (elided)"),
 * oldest first, until the whole fits `budget`; the last `keepWhole` results stay whole.
 */
export function compactWire(wire: readonly AgentWire[], budget = COMPACT_BUDGET, keepWhole = KEEP_WHOLE): AgentWire[] {
  let total = wire.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return [...wire];
  const tools = wire.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const elidable = new Set(tools.slice(0, Math.max(0, tools.length - keepWhole)));
  return wire.map((m, i) => {
    if (total <= budget || !elidable.has(i) || m.role !== "tool" || !("brief" in m)) return m;
    const content = `${m.brief} (elided)`;
    if (content.length >= m.content.length) return m;
    total -= m.content.length - content.length;
    return { ...m, content };
  });
}

/** The wire as the server takes it (summaries stay here). */
const toRequest = (wire: readonly AgentWire[]): DeskChatWire[] => wire.map(m => (m.role === "tool" ? { role: "tool", name: m.name, content: m.content } : m));

const STOP_WORDS = new Set(
  "about above after again against because before being below between could doesn should their there these those through under until where which while would with without dalla dalle della delle degli dello nella nelle negli sulla sulle quando quello questa questo sono come anche ancora dopo prima senza tutti tutte"
    .split(" "),
);

/** What the extracts look for: each issue's key, then two distinctive words of its title. */
export function extractQueries(issues: readonly { key: string; title: string }[]): string[] {
  const out: string[] = [];
  const add = (q: string) => !out.includes(q) && out.push(q);
  for (const issue of issues) {
    add(issue.key);
    const words = (issue.title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(w => w.length >= 5 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
    [...new Set(words)]
      .map((w, i) => ({ w, i }))
      .sort((a, b) => b.w.length - a.w.length || a.i - b.i)
      .slice(0, 2)
      .forEach(({ w }) => add(w));
  }
  return out.slice(0, EXTRACT_QUERIES);
}

/** The extracts as one Markdown block: each search under its own heading, empty ones left out, capped. */
export function formatExtracts(items: readonly { label: string; text: string }[], cap = EXTRACTS_CHARS): string {
  return capText(
    items
      .filter(i => i.text.trim())
      .map(i => `### ${i.label}\n${i.text.trim()}`)
      .join("\n\n"),
    cap,
  );
}

class Stopped extends Error {}

/** Runs one question to its answer; says what happens through `emit`. */
export async function runAgent(input: AgentInput, deps: AgentDeps, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentEnd> {
  const check = () => {
    if (signal?.aborted) throw new Stopped();
  };
  const step = async (call: DeskChatToolCall): Promise<ToolRun> => {
    const s: AgentStep = { id: randomUUID(), call, status: "running", brief: deps.describe?.(call) ?? call.name, text: "" };
    emit({ type: "step", step: s });
    let run: ToolRun;
    if (!input.tools.includes(call.name)) run = { ok: false, text: `error: ${call.name} can't be used here`, brief: `${call.name}: not available` };
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<ToolRun>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, text: "error: the tool took too long", brief: `${s.brief}: too slow` }), deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS);
      });
      try {
        run = await Promise.race([deps.runTool(call, signal), late]);
      } catch (e) {
        if (signal?.aborted) throw new Stopped();
        run = { ok: false, text: `error: ${e instanceof Error ? e.message : String(e)}`, brief: `${s.brief}: failed` };
      } finally {
        clearTimeout(timer);
      }
    }
    const text = capText(run.text, TOOL_RESULT_CHARS);
    emit({ type: "step", step: { ...s, status: run.ok ? "done" : "failed", brief: run.brief, text } });
    check();
    return { ...run, text };
  };

  try {
    let extracts: string | undefined;
    if (input.mode === "extracts") {
      const found: { label: string; text: string }[] = [];
      const queries = extractQueries(input.issues);
      for (const repo of input.repos.slice(0, EXTRACT_REPOS)) {
        for (const query of queries) {
          if (!input.tools.includes("grep")) break;
          const run = await step({ name: "grep", arguments: { repo, query } });
          if (run.ok && !run.empty) found.push({ label: `grep "${query}" in ${repo}`, text: run.text });
        }
        if (input.tools.includes("git_log"))
          for (const issue of input.issues) {
            const run = await step({ name: "git_log", arguments: { repo, grep: issue.key, limit: 5 } });
            if (run.ok && !run.empty) found.push({ label: `commits mentioning ${issue.key} in ${repo}`, text: run.text });
          }
      }
      extracts = formatExtracts(found);
    }

    let wire: AgentWire[] = [...input.history, { role: "user", content: input.question }];
    for (let round = 0; ; round++) {
      check();
      const offered = input.mode === "tools" && round < MAX_TOOL_ROUNDS ? input.tools : [];
      const body: DeskChatRequest = { panes: input.panes, messages: toRequest(compactWire(wire)), tools: offered, repos: input.repos, ...(extracts ? { extracts } : {}) };
      let text = "";
      let calls: DeskChatToolCall[] | null = null;
      let ended = false;
      for await (const e of deps.post(body, signal)) {
        if (e.event === "context") emit({ type: "context", issues: e.data.issues });
        else if (e.event === "delta") {
          text += e.data.text;
          emit({ type: "delta", text: e.data.text });
        } else if (e.event === "draft") emit({ type: "draft", doc: e.data.doc });
        else if (e.event === "tool_calls") calls = e.data.calls;
        else if (e.event === "done") {
          emit({ type: "done", markdown: e.data.markdown, doc: e.data.doc });
          ended = true;
        } else if (e.event === "error") {
          emit({ type: "error", message: e.data.message });
          return "error";
        } else if (e.event === "off") {
          emit({ type: "off", message: e.data.message });
          return "off";
        }
      }
      check();
      if (ended) return "done";
      // Ended without a word (the server went away), or tools asked for when none were
      // offered (the model doesn't follow): stop here, said by the page (empty message).
      if (!calls?.length || !offered.length) {
        emit({ type: "error", message: "" });
        return "error";
      }
      emit({ type: "reset" });
      wire = [...wire, { role: "assistant", content: text, tool_calls: calls }];
      for (const call of calls) {
        const run = await step(call);
        wire = [...wire, { role: "tool", name: call.name, content: run.text, brief: run.brief }];
      }
    }
  } catch (e) {
    if (e instanceof Stopped || signal?.aborted) return "stopped";
    throw e;
  }
}
