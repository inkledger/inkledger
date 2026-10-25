import { failureText } from "@/lib/errorText";
import { useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { issueId } from "@/lib/issues";
import type { IssueItem, PinProps } from "@/components/issues/IssueRow";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Manual order of the pinned favorites: live reordering while dragging,
 * saved on drop (or on "Move up/down"), rolled back if the save fails.
 */
export function usePinnedOrder(items: IssueItem[]) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // Only the latest save may drop the draft: quick "Sposta su" clicks must
  // not snap back to an intermediate order.
  const seq = useRef(0);
  const save = trpc.issues.reorderFavorites.useMutation({
    onError: e => toast.error(t("ui.pinnedOrder.failed", { message: failureText(e) })),
  });

  // By identity (issueId): two trackers' APP-1 are two favorites.
  const byKey = useMemo(() => new Map(items.map(i => [issueId(i), i])), [items]);
  const keys = draft ?? items.map(i => issueId(i));
  const ordered = keys
    .map(k => byKey.get(k))
    .filter((i): i is IssueItem => i !== undefined);

  const commit = (next: string[]) => {
    setDraft(next);
    const mine = ++seq.current;
    save.mutate(
      {
        keys: next.flatMap(id => byKey.get(id)?.key ?? []),
        items: next.flatMap(id => {
          const i = byKey.get(id);
          return i ? [{ key: i.key, connectionId: i.connectionId }] : [];
        }),
      },
      {
        onSettled: () => {
          if (mine !== seq.current) return;
          void Promise.all([
            utils.issues.list.invalidate(),
            utils.issues.all.invalidate(), utils.issues.favorites.invalidate(),
          ]).then(() => {
            if (mine === seq.current) setDraft(null);
          });
        },
      }
    );
  };

  const move = (key: string, dir: -1 | 1) => {
    const i = keys.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return;
    const next = [...keys];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };

  const pinFor = (key: string, index: number): PinProps => ({
    first: index === 0,
    last: index === ordered.length - 1,
    onMove: move,
    dragging: dragKey === key,
    over: overKey === key && dragKey !== key,
    onDragStart: k => {
      setDragKey(k);
      setDraft(keys);
    },
    onDragEnter: k => {
      if (!dragKey || k === dragKey) return;
      setOverKey(k);
      // Live preview: the dragged row takes the hovered row's place.
      setDraft(prev => {
        const list = [...(prev ?? keys)];
        const from = list.indexOf(dragKey);
        const to = list.indexOf(k);
        if (from < 0 || to < 0) return prev;
        list.splice(to, 0, ...list.splice(from, 1));
        return list;
      });
    },
    onDragEnd: () => {
      const changed = draft && draft.some((k, i) => k !== (items[i] ? issueId(items[i]) : undefined));
      setDragKey(null);
      setOverKey(null);
      if (changed && draft) commit(draft);
      else setDraft(null);
    },
  });

  return { ordered, pinFor, saving: save.isPending };
}
