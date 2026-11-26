import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";

export type InboxRow = inferRouterOutputs<AppRouter>["notifications"]["inbox"][number];

/** The server takes this many ids per call: more go in several. */
const CHUNK = 200;
const chunks = (ids: readonly number[]) => Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * The notifications page's data: the open ones (polled) and, when asked, the done ones; read / unread,
 * done and back to open, each optimistic (the counts move at once) and settled by a refetch.
 */
export function useInbox({ done }: { done: boolean }) {
  const utils = trpc.useUtils();
  const open = trpc.notifications.inbox.useQuery({ done: false }, { refetchInterval: 60_000 });
  const closed = trpc.notifications.inbox.useQuery({ done: true }, { enabled: done });
  const refresh = () => {
    void utils.notifications.inbox.invalidate();
    void utils.notifications.list.invalidate();
    void utils.notifications.count.invalidate();
  };
  const fail = (e: unknown) => {
    toastError(e);
    refresh();
  };
  const markRead = trpc.notifications.markRead.useMutation({ onError: fail, onSettled: refresh });
  const dismissMany = trpc.notifications.dismissMany.useMutation({ onError: fail, onSettled: refresh });
  const restore = trpc.notifications.restore.useMutation({ onError: fail, onSettled: refresh });

  const setOpen = (fn: (rows: InboxRow[]) => InboxRow[]) => {
    void utils.notifications.inbox.cancel({ done: false });
    utils.notifications.inbox.setData({ done: false }, old => (old ? fn(old) : old));
  };
  return {
    open,
    closed,
    rows: done ? (closed.data ?? []) : (open.data ?? []),
    query: done ? closed : open,
    setRead: (ids: readonly number[], read: boolean) => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      const now = new Date();
      setOpen(rows => rows.map(n => (set.has(n.id) ? { ...n, readAt: read ? (n.readAt ?? now) : null } : n)));
      for (const part of chunks(ids)) markRead.mutate({ ids: part, read });
    },
    done: (ids: readonly number[]) => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      setOpen(rows => rows.filter(n => !set.has(n.id)));
      for (const part of chunks(ids)) dismissMany.mutate({ ids: part });
    },
    restore: (ids: readonly number[]) => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      void utils.notifications.inbox.cancel({ done: true });
      utils.notifications.inbox.setData({ done: true }, old => old?.filter(n => !set.has(n.id)));
      for (const part of chunks(ids)) restore.mutate({ ids: part });
    },
  };
}
