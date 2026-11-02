import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { trpc } from "@/lib/trpc";
import { parseIssuePath, type IssueLinkRef } from "@/lib/issues";

/** The shell's way to the Desk: the work is in lib/desk/send, loaded on first use. */
export function useDeskContext() {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const location = useLocation();
  const latest = useRef({ utils, navigate, pathname: location.pathname, search: location.search });
  useEffect(() => {
    latest.current = { utils, navigate, pathname: location.pathname, search: location.search };
  });
  return latest;
}

/**
 * Shift-click on any in-app issue link opens it beside: on the Desk in its first empty slot, on an
 * issue's page the Desk with both, elsewhere added to the desk (a toast says so). Shift alone:
 * ⌘/Ctrl-click still opens a tab. It takes the browser's "open in a new window" on issue links only.
 */
export function useOpenBeside() {
  const context = useDeskContext();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.button !== 0 || e.defaultPrevented) return;
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.origin !== window.location.origin || link.target === "_blank" || link.hasAttribute("download")) return;
      const ref = parseIssuePath(link.pathname + link.search);
      if (!ref) return;
      e.preventDefault();
      e.stopPropagation();
      void import("@/lib/desk/send").then(m => m.openBeside(ref, context.current));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [context]);
}

/** An issue (a row, a board card) as a link to it. */
export const refOf = (issue: { connectionId: number; key: string; remoteId?: string | null }): IssueLinkRef =>
  issue.remoteId ? { connectionId: issue.connectionId, remoteId: issue.remoteId } : { connectionId: issue.connectionId, key: issue.key };

/** "Open beside" from a menu (a row's, a card's): what Shift-click on its link does. */
export function useOpenBesideAction() {
  const context = useDeskContext();
  return (issue: { connectionId: number; key: string; remoteId?: string | null }) =>
    void import("@/lib/desk/send").then(m => m.openBeside(refOf(issue), context.current));
}
