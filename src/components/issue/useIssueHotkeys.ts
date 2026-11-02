import { useEffect, useRef } from "react";
import { inFloat, isDialogOpen, isTyping } from "@/lib/dom";
import { hotkeySequence } from "@/lib/hotkeySequence";
import type { useIssueActions } from "@/hooks/useIssueActions";

type Actions = ReturnType<typeof useIssueActions>;
type Flags = { favorite: boolean; hidden: boolean; summary: string } | null;
type Named = Parameters<Actions["copyBranch"]>[0] | null;

/**
 * The issue's hotkeys: "l" log time, "s" favorite, "h" hide / restore, "c" / "b" / "m" copy
 * key / branch name / commit message. Listened to only while `enabled` (the page; the
 * active pane of a desk), so two issues on screen never both answer one key.
 */
export function useIssueHotkeys({
  enabled,
  issueKey: key,
  connectionId: connection,
  flags,
  named,
  act,
  onLogTime,
}: {
  enabled: boolean;
  issueKey: string;
  /** The issue's own connection, once loaded. */
  connectionId: number | undefined;
  /** Favorite / hide need the issue in the catalog. */
  flags: Flags;
  /** Branch and commit message need only the summary: remote issues too. */
  named: Named;
  act: Actions;
  onLogTime: () => void;
}) {
  const keyRef = useRef({ key, connection, flags, act, named, onLogTime });
  useEffect(() => {
    keyRef.current = { key, connection, flags, act, named, onLogTime };
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || isDialogOpen() || inFloat(e.target)) return;
      if (hotkeySequence.pending()) return; // "g b" navigates, it doesn't copy
      const { key: k, connection: c, flags: f, act: a, named: n, onLogTime: log } = keyRef.current;
      if (e.key === "l") {
        e.preventDefault();
        log();
      } else if (e.key === "s" && f && !f.hidden) {
        e.preventDefault();
        void a.toggleFavorite(k, c);
      } else if (e.key === "h" && f) {
        e.preventDefault();
        if (f.hidden) void a.restore(k, c);
        else void a.hide(k, c);
      } else if (e.key === "c") {
        e.preventDefault();
        void a.copyKey(k);
      } else if (e.key === "b" && n) {
        e.preventDefault();
        void a.copyBranch(n);
      } else if (e.key === "m" && n) {
        e.preventDefault();
        void a.copyCommit(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
