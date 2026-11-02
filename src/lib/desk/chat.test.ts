import { describe, expect, it } from "vitest";
import { chatMarkdown, readEvents, type ChatMessage } from "./chat";

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
