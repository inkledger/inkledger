import { useEffect, useState, useSyncExternalStore } from "react";
import { CHAT_TYPING_MS } from "@contracts/chat";
import type { ChatChange } from "@contracts/liveEvents";
import { createStore } from "@/lib/store";

/**
 * What /api/events says about chats, for the pages that show them: who is typing where (never
 * kept: it expires), which threads are on screen (their news is read there, not announced), and
 * a line to the open threads so a new message appears at once.
 */

export type ChatEvent = { threadId: number; change: ChatChange; by: number; messageId?: number; origin?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The event's data, when it is a chat event. */
export function asChatEvent(data: unknown): ChatEvent | null {
  if (!isRecord(data) || typeof data.threadId !== "number" || typeof data.change !== "string" || typeof data.by !== "number") return null;
  return {
    threadId: data.threadId,
    change: data.change as ChatChange,
    by: data.by,
    messageId: typeof data.messageId === "number" ? data.messageId : undefined,
    origin: typeof data.origin === "string" ? data.origin : undefined,
  };
}

// --- Typing ------------------------------------------------------------------

/** threadId → userId → until (epoch ms). */
const typing = createStore<ReadonlyMap<number, ReadonlyMap<number, number>>>(new Map());

export function noteTyping(threadId: number, userId: number, now = Date.now()) {
  const next = new Map(typing.get());
  const inThread = new Map(next.get(threadId) ?? []);
  inThread.set(userId, now + CHAT_TYPING_MS);
  next.set(threadId, inThread);
  typing.set(next);
}

/** Someone's message arrived: they stopped typing. */
export function clearTyping(threadId: number, userId: number) {
  const inThread = typing.get().get(threadId);
  if (!inThread?.has(userId)) return;
  const next = new Map(typing.get());
  const left = new Map(inThread);
  left.delete(userId);
  next.set(threadId, left);
  typing.set(next);
}

/** Who is typing in a thread now (not `self`), refreshed as each one expires. */
export function useTyping(threadId: number, self: number | null): number[] {
  const all = useSyncExternalStore(typing.subscribe, typing.get, typing.get);
  const [now, setNow] = useState(() => Date.now());
  const inThread = all.get(threadId);
  const until = [...(inThread ?? new Map<number, number>()).entries()].filter(([u, at]) => u !== self && at > now);
  const next = until.length ? Math.min(...until.map(([, at]) => at)) : null;
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(50, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next, all]);
  return until.map(([u]) => u);
}

// --- Threads on screen -------------------------------------------------------

/** How many views show each thread now (a pane, an issue's section): its news is read there. */
const onScreen = new Map<number, number>();

/** While mounted (and the page visible), the thread is being read here. */
export function useThreadOnScreen(threadId: number | null) {
  useEffect(() => {
    if (threadId === null) return;
    onScreen.set(threadId, (onScreen.get(threadId) ?? 0) + 1);
    return () => {
      const n = (onScreen.get(threadId) ?? 1) - 1;
      if (n <= 0) onScreen.delete(threadId);
      else onScreen.set(threadId, n);
    };
  }, [threadId]);
}

/** Whether a thread is on screen in a visible page (then nothing pops up for it). */
export const threadOnScreen = (threadId: number) => onScreen.has(threadId) && typeof document !== "undefined" && document.visibilityState === "visible";

// --- Events to open threads --------------------------------------------------

const listeners = new Set<(e: ChatEvent) => void>();

/** Hands an event to every open view (their messages follow). */
export function emitChat(e: ChatEvent) {
  for (const l of listeners) l(e);
}

/** Listen to chat events while mounted. */
export function useChatEvents(on: (e: ChatEvent) => void) {
  useEffect(() => {
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, [on]);
}
