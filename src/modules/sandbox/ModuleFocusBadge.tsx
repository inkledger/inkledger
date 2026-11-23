import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Puzzle } from "lucide-react";
import { currentLocale, t } from "@/i18n";
import { Chip } from "@/components/app/Chip";
import { focusedView, pageFocusBadge } from "./focusBadge";

/** The chip's height (h-5), its gap from the box and from the screen's edge, in px. */
const CHIP_H = 20;
const GAP = 4;
const EDGE = 4;

const subscribe = (fn: () => void) => pageFocusBadge().subscribe(fn);
const none = () => null;

/**
 * The framed module the focus is in, named by the host above its box (below
 * it, or inside its top edge, when there's no room), over every module frame.
 */
export function ModuleFocusBadge() {
  const view = useSyncExternalStore(subscribe, focusedView, none);
  const ref = useRef<HTMLDivElement>(null);
  const box = view?.box ?? null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !box) return;
    let frame = 0;
    // Read once as the focus comes in, then at most once a frame while the page scrolls or resizes.
    const place = () => {
      frame = 0;
      const r = box.getBoundingClientRect();
      const above = r.top - GAP - CHIP_H;
      const y = above >= EDGE ? above : r.bottom + GAP + CHIP_H <= innerHeight - EDGE ? r.bottom + GAP : Math.max(EDGE, r.top + GAP);
      const x = Math.min(Math.max(EDGE, r.left), innerWidth - EDGE);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.maxWidth = `${Math.max(0, Math.floor(innerWidth - x - EDGE))}px`;
    };
    const later = () => void (frame ||= requestAnimationFrame(place));
    place();
    const opts = { capture: true, passive: true };
    addEventListener("scroll", later, opts);
    addEventListener("resize", later, opts);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("scroll", later, opts);
      removeEventListener("resize", later, opts);
    };
  }, [box]);
  const label = view ? t("ui.moduleFocus.badge", { name: view.name[currentLocale() === "it" ? "it" : "en"] }) : "";
  return (
    <>
      {/* Said once each time the focus goes into a module (emptied as it leaves). */}
      <p role="status" aria-live="polite" className="sr-only">
        {label}
      </p>
      {view &&
        createPortal(
          <div ref={ref} aria-hidden data-module-focus-badge={view.moduleId} className="pointer-events-none fixed left-0 top-0 z-[60]">
            <Chip className="max-w-full shadow-xs">
              <Puzzle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{label}</span>
            </Chip>
          </div>,
          document.body,
        )}
    </>
  );
}
