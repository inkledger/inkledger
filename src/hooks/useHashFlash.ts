import { useEffect } from "react";
import { useLocation } from "react-router";
import { decodeOr } from "@/lib/urlCodecs";

/** The element id a #comment-… or #note-… hash points at, or null for any other hash. */
export function flashTarget(hash: string): string | null {
  return /^#(comment|note)-./.test(hash) ? decodeOr(hash.slice(1)) : null;
}

/**
 * Arriving on an issue at #comment-… or #note-… (a TODO's link): that comment
 * or note, once its section has loaded, is scrolled into view and marked for
 * two seconds (data-flash).
 */
export function useHashFlash() {
  const { hash, key } = useLocation();
  useEffect(() => {
    const id = flashTarget(hash);
    if (id === null) return;
    let tries = 0;
    let wait: ReturnType<typeof setTimeout> | undefined;
    let off: ReturnType<typeof setTimeout> | undefined;
    let el: HTMLElement | null = null;
    const look = () => {
      el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.setAttribute("data-flash", "");
        off = setTimeout(() => el?.removeAttribute("data-flash"), 2000);
        return;
      }
      // The sections load on their own: a few seconds at most.
      if (++tries < 50) wait = setTimeout(look, 100);
    };
    look();
    return () => {
      clearTimeout(wait);
      clearTimeout(off);
      el?.removeAttribute("data-flash");
    };
  }, [hash, key]);
}
