// The streamed answer of Ollama's /api/chat (NDJSON: one JSON object a line,
// the last one `done`), read as the text the model writes.
import { describe, expect, it } from "vitest";
import { OllamaError, readOllamaPieces, readOllamaStream } from "./ollama";

const encode = (s: string) => new TextEncoder().encode(s);
async function* chunks(...parts: (string | Uint8Array)[]) {
  for (const p of parts) yield typeof p === "string" ? encode(p) : p;
}
const all = async (source: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const piece of source) out.push(piece);
  return out;
};
const line = (content: string, done = false) => `${JSON.stringify({ message: { role: "assistant", content }, done })}\n`;

describe("readOllamaStream", () => {
  it("yields each line's content, lines split anywhere across chunks", async () => {
    const text = line("Hello") + line(", APP-1") + line("", true);
    const cut = [text.slice(0, 7), text.slice(7, 30), text.slice(30, 31), text.slice(31)];
    expect(await all(readOllamaStream(chunks(...cut)))).toEqual(["Hello", ", APP-1"]);
  });

  it("a character split between chunks stays whole", async () => {
    const bytes = encode(line("è più") + line("", true));
    const at = bytes.indexOf(0xc3) + 1;
    expect((await all(readOllamaStream(chunks(bytes.slice(0, at), bytes.slice(at))))).join("")).toBe("è più");
  });

  it("stops at the done message (what follows is ignored), blank lines skipped", async () => {
    expect(await all(readOllamaStream(chunks(line("a"), "\n\n", line("b", true), line("c"))))).toEqual(["a", "b"]);
  });

  it("an error line is an error, and so is a stream cut before done", async () => {
    await expect(all(readOllamaStream(chunks(line("a"), `${JSON.stringify({ error: "model not found" })}\n`)))).rejects.toThrow(OllamaError);
    await expect(all(readOllamaStream(chunks(line("a"), "{ not json\n")))).rejects.toThrow(OllamaError);
    await expect(all(readOllamaStream(chunks(line("a"))))).rejects.toThrow(/before the end/);
  });

  it("a last line without its newline still counts", async () => {
    expect(await all(readOllamaStream(chunks(line("a"), line("b", true).trimEnd())))).toEqual(["a", "b"]);
  });
});

describe("readOllamaPieces", () => {
  it("tool calls come as their own piece, arguments as an object or JSON text", async () => {
    const calls = (list: unknown[]) => `${JSON.stringify({ message: { role: "assistant", content: "", tool_calls: list }, done: false })}\n`;
    const out: unknown[] = [];
    const text = line("Let me look") + calls([{ function: { name: "grep", arguments: { repo: "app", query: "MAGA-400" } } }, { function: { name: "read", arguments: '{"repo":"app","path":"a.kt"}' } }, { nope: 1 }]) + line("", true);
    for await (const piece of readOllamaPieces(chunks(text))) out.push(piece);
    expect(out).toEqual([
      { text: "Let me look" },
      {
        toolCalls: [
          { name: "grep", arguments: { repo: "app", query: "MAGA-400" } },
          { name: "read", arguments: { repo: "app", path: "a.kt" } },
        ],
      },
    ]);
  });
});
