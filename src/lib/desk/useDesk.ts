import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { emptyDesk, type DeskLayout } from "@contracts/desk";

/** Quiet time before a change is saved: a burst of changes (keys held on a divider) saves once. */
const SAVE_AFTER_MS = 300;

export type DeskChange = (desk: DeskLayout) => DeskLayout;

/**
 * The current desk: changes show at once and are saved after 300 ms of quiet, or right
 * away when the page goes (pagehide, unmount). Once changed here, the page keeps its own
 * desk: a refetch answered before the last save never brings back an older one.
 */
export function useDesk() {
  const utils = trpc.useUtils();
  const current = trpc.desks.current.useQuery(undefined, { staleTime: 30_000 });
  const { mutate } = trpc.desks.setCurrent.useMutation();
  const pending = useRef<DeskLayout | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [local, setLocal] = useState<DeskLayout | null>(null);
  const latest = useRef<DeskLayout | null>(null);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const layout = pending.current;
    pending.current = null;
    if (layout) mutate({ layout });
  }, [mutate]);

  const change = useCallback(
    (fn: DeskChange, { saveNow = false }: { saveNow?: boolean } = {}) => {
      const before = latest.current ?? utils.desks.current.getData() ?? emptyDesk();
      const next = fn(before);
      if (next === before) return;
      latest.current = next;
      setLocal(next);
      // The cache too: the menu's count follows.
      utils.desks.current.setData(undefined, next);
      pending.current = next;
      clearTimeout(timer.current);
      if (saveNow) flush();
      else timer.current = setTimeout(flush, SAVE_AFTER_MS);
    },
    [utils, flush]
  );

  // Leaving (the tab closed, another page): what waits is saved now, once.
  const flushLatest = useRef(flush);
  useEffect(() => {
    flushLatest.current = flush;
  }, [flush]);
  useEffect(() => {
    const leave = () => flushLatest.current();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);

  return { desk: local ?? current.data, query: current, change, flush };
}
