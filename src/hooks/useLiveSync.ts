import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { liveEvents } from "@/lib/liveEvents";
import type { LiveEventType } from "@contracts/liveEvents";
import { useTimers } from "@/hooks/useTimers";
import { TIMER_HEARTBEAT_MS } from "@contracts/timerLock";
import { deviceId } from "@/lib/device";
import { isNoteDirty, publishServerNote } from "@/components/notes/noteSync";
import { asChatEvent, emitChat, noteTyping } from "@/components/chat/chatLive";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

type Utils = ReturnType<typeof trpc.useUtils>;

/** What each event makes this page refetch, by name (several in one frame refetch once). */
const refetches: Record<"timers" | "schedule" | "notesLists" | "decisions" | "chats", (u: Utils) => Promise<unknown>> = {
  // The TODO worked on follows its timer.
  timers: u => Promise.all([u.timers.list.invalidate(), u.todos.working.invalidate()]),
  // Hours changed on another page or device: holes, placement and targets follow at once.
  schedule: u => u.workSchedule.invalidate(),
  notesLists: u => Promise.all([u.notes.tree.invalidate(), u.notes.trash.invalidate(), u.notes.search.invalidate()]),
  decisions: u => u.decisions.list.invalidate(),
  // A chat changed: its lists, counts and header follow (an open thread's messages follow through emitChat).
  chats: u => Promise.all([u.chat.threads.invalidate(), u.chat.unreadCount.invalidate(), u.chat.forIssue.invalidate(), u.chat.thread.invalidate()]),
};
type Refetch = keyof typeof refetches;

/** Which refetches an event asks for ("hello": a reconnect may have missed any of them). */
const asks: Partial<Record<LiveEventType, Refetch[]>> = {
  hello: ["timers", "schedule", "notesLists", "decisions", "chats"],
  timers: ["timers"],
  schedule: ["schedule"],
  notes: ["notesLists"],
  // A question asked, typed or answered on any page (this one's own echo too: the list is the truth).
  decisions: ["decisions"],
};

/**
 * Keeps this tab in step with the user's other pages and devices: refetches
 * what /api/events names, and, while this device controls the running timer,
 * renews its lease (also in a background tab, and at once on waking or
 * reconnecting). A lost lease or a take-over shows on the next fetch.
 */
export function useLiveSync() {
  const utils = trpc.useUtils();
  useEffect(() => {
    // A burst of events (a switch pausing three timers) refetches once, a frame later.
    // A timeout, not requestAnimationFrame: a background tab (or a hidden app window) must follow too.
    const due = new Set<Refetch>();
    let frame: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      frame = null;
      for (const r of due) void refetches[r](utils);
      due.clear();
    };
    const ask = (rs: readonly Refetch[]) => {
      rs.forEach(r => due.add(r));
      frame ??= setTimeout(flush, 16);
    };
    const close = liveEvents.open((type, data) => {
      ask(asks[type] ?? []);
      if (type === "chat") {
        const e = asChatEvent(data);
        // Someone typing: shown where the thread is open, nothing to refetch.
        if (e?.change === "typing") noteTyping(e.threadId, e.by);
        else if (e) {
          emitChat(e);
          ask(["chats"]);
        }
      }
      // Back after missing more than the server kept: everything shown is refetched.
      if (type === "hello" && isRecord(data) && data.resync === true) void utils.invalidate();
      if (type === "hello") void utils.notes.get.invalidate();
      // Another tab of this device switched the bucket: everything here follows, as there.
      if (type === "bucket" && isRecord(data) && data.deviceId === deviceId()) void utils.invalidate();
      if (type === "notes" && isRecord(data) && typeof data.id === "string") {
        const id = data.id;
        if (isNoteDirty(id)) {
          void utils.client.notes.get.query({ id }).then(publishServerNote).catch(() => undefined);
        } else {
          void utils.notes.get.invalidate({ id });
        }
      }
    });
    return () => {
      close();
      if (frame) clearTimeout(frame);
    };
  }, [utils]);

  useEffect(() => {
    // Coming back to a tab fires both visibilitychange and focus (an OS window switch only focus): once is enough.
    let last = 0;
    const refresh = () => {
      const now = performance.now();
      if (last && now - last < 250) return;
      last = now;
      void utils.notes.tree.invalidate();
      void utils.notes.trash.invalidate();
      void utils.notes.search.invalidate();
      void utils.notes.get.invalidate();
    };
    const focus = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [utils]);

  const { timers } = useTimers();
  const owned = timers.some(t => t.state === "running" && t.ownedHere);
  const heartbeat = trpc.timers.heartbeat.useMutation({
    onSuccess: r => {
      if (!r.owned) void utils.timers.list.invalidate();
    },
  });
  const beat = heartbeat.mutate;
  useEffect(() => {
    if (!owned) return;
    beat();
    const i = setInterval(() => beat(), TIMER_HEARTBEAT_MS);
    const now = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", now);
    window.addEventListener("online", now);
    return () => {
      clearInterval(i);
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("online", now);
    };
  }, [owned, beat]);
}
