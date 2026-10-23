import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Arriving on an issue at #comment-… or #note-… (a TODO's link): that comment
 * or note, once its section has loaded, is scrolled into view and marked for
 * two seconds (data-flash).
 */
export function useHashFlash() {
  const { hash, key } = useLocation();
  useEffect(() => {
    if (!/^#(comment|note)-./.test(hash)) return;
    const id = decodeURIComponent(hash.slice(1));
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
