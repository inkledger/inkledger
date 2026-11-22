import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ask, chatMarkdown, clearChat, readEvents, useDeskChat, type ChatMessage, type ChatState } from "./chat";

const body = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });

const all = async <T,>(source: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

describe("the desk chat's events", () => {
  it("reads whole events however the body is cut; comments and empty data skipped", async () => {
    const text = 'event: context\ndata: {"issues":[]}\n\n: keepalive\n\nevent: delta\ndata: {"text":"Hi"}\n\nevent: delta\r\ndata: {"text":" there"}\r\n\r\n';
    const cuts = [text.slice(0, 9), text.slice(9, 40), text.slice(40, 41), text.slice(41)];
    expect(await all(readEvents(body(...cuts)))).toEqual([
      { event: "context", data: { issues: [] } },
      { event: "delta", data: { text: "Hi" } },
      { event: "delta", data: { text: " there" } },
    ]);
  });

  it("a note of the conversation names every issue; failed answers left out", () => {
    const m = (role: ChatMessage["role"], text: string, status: ChatMessage["status"] = "done"): ChatMessage => ({ id: text, role, text, doc: null, status, steps: [] });
    const md = chatMarkdown([m("user", "Which first?"), m("assistant", "APP-1"), m("user", "Why?"), m("assistant", "unreachable", "error")], [
      { connectionId: 1, key: "APP-1", title: "Login" },
      { connectionId: 1, key: "APP-2", title: "Search" },
    ]);
    expect(md).toContain("APP-1 (Login), APP-2 (Search)");
    expect(md).toContain("## Question\n\nWhich first?");
    expect(md).toContain("## Answer\n\nAPP-1");
    expect(md).not.toContain("unreachable");
  });
});

describe("New chat while an answer is being written", () => {
  /** The chat as a page would read it now. */
  const snapshot = (): ChatState => {
    let seen: ChatState | null = null;
    const Probe = () => {
      seen = useDeskChat();
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    if (!seen) throw new Error("not rendered");
    return seen;
  };
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("the next question runs at once, and what the old answer still sends stays out of the new chat", async () => {
    const answers: ReadableStreamDefaultController<Uint8Array>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start: c => void answers.push(c) }), { status: 200, headers: { "Content-Type": "text/event-stream" } })),
    );
    try {
      const first = ask("First?", []);
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      clearChat();
      const second = ask("Second?", []);
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      // The old answer's events, already on their way.
      answers[0].enqueue(bytes('event: context\ndata: {"issues":[{"connectionId":1,"key":"OLD-1","title":"Old"}]}\n\nevent: off\ndata: {"message":"off"}\n\n'));
      answers[0].close();
      await first;
      answers[1].enqueue(bytes('event: context\ndata: {"issues":[{"connectionId":1,"key":"NEW-1","title":"New"}]}\n\nevent: done\ndata: {"markdown":"New answer","doc":{"v":1,"blocks":[]}}\n\n'));
      answers[1].close();
      await second;
      const state = snapshot();
      expect(state.off).toBe(false);
      expect(state.context?.map(i => i.key)).toEqual(["NEW-1"]);
      expect(state.messages.map(m => m.text)).toEqual(["Second?", "New answer"]);
    } finally {
      clearChat();
      vi.unstubAllGlobals();
    }
  });
});
