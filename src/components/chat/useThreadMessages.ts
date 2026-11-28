import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatFileView, ChatMessageView, ChatRef } from "@contracts/chat";
import { trpc } from "@/lib/trpc";
import { randomUUID } from "@/lib/randomId";
import { useLiveState } from "@/lib/liveEvents";
import { clearTyping, useChatEvents, type ChatEvent } from "./chatLive";

/** A message on its way: shown at once, sent (and retried) with its nonce, so it is written once. */
export type PendingMessage = {
  nonce: string;
  body: string;
  refs: ChatRef[];
  files: ChatFileView[];
  replyToId?: number;
  state: "sending" | "failed";
  error?: string;
};

const newNonce = () => randomUUID();

/** Messages by id, oldest first, the newer copy of each winning. */
function merge(into: ChatMessageView[], add: ChatMessageView[]): ChatMessageView[] {
  if (add.length === 0) return into;
  const byId = new Map(into.map((m) => [m.id, m]));
  for (const m of add) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * One thread's messages, kept while it is open: the latest page first, earlier ones on demand,
 * newer ones as they are told (live) or every few seconds when the stream is down; what is sent
 * shows at once and is retried with the same nonce.
 */
export function useThreadMessages(threadId: number) {
  const utils = trpc.useUtils();
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [olderMore, setOlderMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const latest = useRef({ messages, threadId });
  useEffect(() => {
    latest.current = { messages, threadId };
  });

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const page = await utils.client.chat.messages.query({ threadId });
      if (latest.current.threadId !== threadId) return;
      setMessages(page.messages);
      setOlderMore(page.olderMore);
      setStatus("ready");
      setError(null);
    } catch (e) {
      setError(e);
      setStatus("error");
    }
  }, [threadId, utils]);

  useEffect(() => {
    setMessages([]);
    setPending([]);
    void load();
  }, [load]);

  /** What came after the newest one here. */
  const refreshNewer = useCallback(async () => {
    const last = latest.current.messages.at(-1)?.id ?? 0;
    try {
      let after = last;
      for (let i = 0; i < 10; i++) {
        const page = await utils.client.chat.messages.query({ threadId, after });
        if (latest.current.threadId !== threadId) return;
        setMessages((m) => merge(m, page.messages));
        if (!page.newerMore || page.messages.length === 0) break;
        after = page.messages.at(-1)!.id;
      }
    } catch {
      // The next event or poll tries again.
    }
  }, [threadId, utils]);

  /** One message changed (edited, removed, a reaction): read again with those around it. */
  const refreshAround = useCallback(
    async (id: number) => {
      try {
        const page = await utils.client.chat.messages.query({ threadId, around: id });
        if (latest.current.threadId !== threadId) return;
        const known = new Set(latest.current.messages.map((m) => m.id));
        setMessages((m) => merge(m, page.messages.filter((x) => known.has(x.id))));
      } catch {
        // Shown as it was until the next change.
      }
    },
    [threadId, utils],
  );

  const loadOlder = useCallback(async () => {
    const first = latest.current.messages[0]?.id;
    if (first === undefined) return;
    setLoadingOlder(true);
    try {
      const page = await utils.client.chat.messages.query({ threadId, before: first });
      if (latest.current.threadId !== threadId) return;
      setMessages((m) => merge(m, page.messages));
      setOlderMore(page.olderMore);
    } finally {
      setLoadingOlder(false);
    }
  }, [threadId, utils]);

  useChatEvents(
    useCallback(
      (e: ChatEvent) => {
        if (e.threadId !== threadId) return;
        if (e.change === "message") {
          clearTyping(threadId, e.by);
          void refreshNewer();
        } else if ((e.change === "edit" || e.change === "react") && e.messageId !== undefined) {
          void refreshAround(e.messageId);
          // A publish adds a line too.
          if (e.change === "edit") void refreshNewer();
        } else if (e.change === "members" || e.change === "state") void refreshNewer();
      },
      [threadId, refreshNewer, refreshAround],
    ),
  );

  // While the stream is down nothing is told: newer messages are asked for every few seconds.
  const live = useLiveState();
  useEffect(() => {
    if (live === "live") return;
    const timer = setInterval(() => void refreshNewer(), 10_000);
    return () => clearInterval(timer);
  }, [live, refreshNewer]);
  // Back to the page, or the stream back: catch up at once.
  useEffect(() => {
    const now = () => document.visibilityState === "visible" && void refreshNewer();
    document.addEventListener("visibilitychange", now);
    return () => document.removeEventListener("visibilitychange", now);
  }, [refreshNewer]);
  useEffect(() => {
    if (live === "live") void refreshNewer();
  }, [live, refreshNewer]);

  const sendMutation = trpc.chat.send.useMutation();
  const sendOne = useCallback(
    async (p: PendingMessage) => {
      setPending((list) => list.map((x) => (x.nonce === p.nonce ? { ...x, state: "sending", error: undefined } : x)));
      try {
        const m = await sendMutation.mutateAsync({ threadId, body: p.body, refs: p.refs, fileIds: p.files.map((f) => f.id), replyToId: p.replyToId, clientNonce: p.nonce });
        setMessages((list) => merge(list, [m]));
        setPending((list) => list.filter((x) => x.nonce !== p.nonce));
        void utils.chat.threads.invalidate();
        void utils.chat.forIssue.invalidate();
        void utils.chat.thread.invalidate({ threadId });
      } catch (e) {
        setPending((list) => list.map((x) => (x.nonce === p.nonce ? { ...x, state: "failed", error: e instanceof Error ? e.message : String(e) } : x)));
      }
    },
    [threadId, sendMutation, utils],
  );

  const send = useCallback(
    (draft: { body: string; refs: ChatRef[]; files: ChatFileView[]; replyToId?: number }) => {
      const p: PendingMessage = { ...draft, nonce: newNonce(), state: "sending" };
      setPending((list) => [...list, p]);
      void sendOne(p);
    },
    [sendOne],
  );
  const retry = useCallback((nonce: string) => {
    const p = pending.find((x) => x.nonce === nonce);
    if (p) void sendOne(p);
  }, [pending, sendOne]);
  const discard = useCallback((nonce: string) => setPending((list) => list.filter((x) => x.nonce !== nonce)), []);

  return useMemo(
    () => ({ messages, pending, olderMore, loadingOlder, status, error, reload: load, loadOlder, send, retry, discard, refreshNewer, refreshAround }),
    [messages, pending, olderMore, loadingOlder, status, error, load, loadOlder, send, retry, discard, refreshNewer, refreshAround],
  );
}

export type ThreadMessages = ReturnType<typeof useThreadMessages>;
