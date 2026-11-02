import { useSyncExternalStore } from "react";
import { DESK_CHAT_PATH, type DeskChatEvent, type DeskChatIssue, type DeskChatTurn } from "@contracts/deskChat";
import type { DeskSlot } from "@contracts/desk";
import type { RichDoc } from "@contracts/richtext";
import { getLocale, t } from "@/i18n";
import { randomUUID } from "@/lib/randomId";

/**
 * The Desk's chat in the browser (docs/work/desk.md, batch 4c): the conversation lives
 * here for as long as the page does, never on the server. An answer goes on streaming
 * while the panel is closed; "New chat" (or a desk whose issues all changed) clears it.
 */

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** The answer drawn as a document: so far while it is written, then the whole of it. */
  doc: RichDoc | null;
  status: "streaming" | "done" | "stopped" | "error";
};

export type ChatState = {
  messages: ChatMessage[];
  /** The issues the last answer read (null before the first question). */
  context: DeskChatIssue[] | null;
  /** The model is off (said by the server). */
  off: boolean;
  /** The last answer finished, for the live region (said once, not each piece). */
  finished: { id: string; text: string } | null;
};

const EMPTY: ChatState = { messages: [], context: null, off: false, finished: null };
let state = EMPTY;
let running: AbortController | null = null;
const listeners = new Set<() => void>();

const set = (next: (s: ChatState) => ChatState) => {
  state = next(state);
  listeners.forEach(l => l());
};
const patch = (id: string, change: (m: ChatMessage) => ChatMessage) =>
  set(s => ({ ...s, messages: s.messages.map(m => (m.id === id ? change(m) : m)) }));

export function useDeskChat(): ChatState {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** Server-sent events in a body read piece by piece: whole events only, split anywhere. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<DeskChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at: number;
      while ((at = pending.search(/\r?\n\r?\n/)) >= 0) {
        const block = pending.slice(0, at);
        pending = pending.slice(at).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        // The server's own events (contracts/deskChat.ts), read as they are typed there.
        if (data.length) yield { event, data: JSON.parse(data.join("\n")) as unknown } as DeskChatEvent;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The turns sent back: questions, and answers that came (whole or stopped). */
const turns = (messages: readonly ChatMessage[]): DeskChatTurn[] =>
  messages.filter(m => m.role === "user" || (m.status !== "error" && m.text.trim())).map(m => ({ role: m.role, content: m.text }));

/** Asks the conversation's next question about the issues in `panes` (the desk's shown slots). */
export async function ask(question: string, panes: readonly DeskSlot[]): Promise<void> {
  const text = question.trim();
  if (!text || running) return;
  const asked: ChatMessage = { id: randomUUID(), role: "user", text, doc: null, status: "done" };
  const answer: ChatMessage = { id: randomUUID(), role: "assistant", text: "", doc: null, status: "streaming" };
  set(s => ({ ...s, messages: [...s.messages, asked, answer], finished: null }));
  const controller = new AbortController();
  running = controller;
  const fail = (message: string) => patch(answer.id, m => ({ ...m, text: message, status: "error" }));
  try {
    const res = await fetch(DESK_CHAT_PATH, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "x-locale": getLocale() },
      body: JSON.stringify({ panes, messages: turns(state.messages.filter(m => m.id !== answer.id)) }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const said = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return fail(typeof said?.error === "string" ? said.error : t("pages.deskChat.failed"));
    }
    for await (const e of readEvents(res.body)) {
      if (e.event === "context") set(s => ({ ...s, context: e.data.issues }));
      else if (e.event === "delta") patch(answer.id, m => ({ ...m, text: m.text + e.data.text }));
      else if (e.event === "draft") patch(answer.id, m => ({ ...m, doc: e.data.doc }));
      else if (e.event === "done") {
        patch(answer.id, m => ({ ...m, text: e.data.markdown, doc: e.data.doc, status: "done" }));
        set(s => ({ ...s, finished: { id: answer.id, text: e.data.markdown } }));
      } else if (e.event === "error") fail(e.data.message);
      else if (e.event === "off") set(s => ({ ...s, off: true, messages: s.messages.filter(m => m.id !== answer.id && m.id !== asked.id) }));
    }
    // Ended without a word (the server went away): said, the question kept.
    if (state.messages.find(m => m.id === answer.id)?.status === "streaming") fail(t("pages.deskChat.failed"));
  } catch {
    if (controller.signal.aborted) patch(answer.id, m => ({ ...m, status: "stopped" }));
    else fail(t("pages.deskChat.failed"));
  } finally {
    if (running === controller) running = null;
  }
}

/** Stops the answer being written: what came so far stays, marked as stopped. */
export function stop(): void {
  running?.abort();
}

/** "New chat": the conversation forgotten (an answer being written is stopped). */
export function clearChat(): void {
  stop();
  set(() => EMPTY);
}

/** The conversation as a note: the issues' keys, then each question and answer. */
export function chatMarkdown(messages: readonly ChatMessage[], issues: readonly DeskChatIssue[]): string {
  return [
    `${t("pages.deskChat.noteIssues")}: ${issues.map(i => `${i.key} (${i.title})`).join(", ")}`,
    ...messages
      .filter(m => m.status !== "error" && m.text.trim())
      .map(m => `## ${m.role === "user" ? t("pages.deskChat.noteQuestion") : t("pages.deskChat.noteAnswer")}\n\n${m.text.trim()}`),
  ].join("\n\n");
}
