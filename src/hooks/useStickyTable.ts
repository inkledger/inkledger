import { useEffect, type RefObject } from "react";

/** The middle columns keep at least this much room; narrower, nothing sticks and the whole table scrolls. */
const MIDDLE_MIN = 160;

/**
 * A table with frozen columns at both ends (cells marked `data-stick="1".."n"` from the left, `"r1".."rn"`
 * from the right) and a header strip that stays under the page's bars while its header row has scrolled
 * away (docs/design-system.md §7). Everything is written to the DOM directly, never through React state:
 * - the frozen cells' offsets and the strip's column widths, from a ResizeObserver on the header row;
 * - whether the columns stick at all (`data-sticky` on the wrapper: only when the middle keeps room);
 * - whether something is scrolled under either frozen edge (`data-under-start` / `data-under-end`), from
 *   an IntersectionObserver on two sentinels at the ends of the scrolled content;
 * - whether the header row is under the bars (`data-stuck`, the strip shows), from an IntersectionObserver;
 * - the strip's sideways scroll, mirrored from the table's in a passive listener;
 * - a focused control in the middle columns brought out from under the frozen ones.
 */
export function useStickyTable({
  wrap,
  scroller,
  head,
  strip,
}: {
  wrap: RefObject<HTMLElement | null>;
  scroller: RefObject<HTMLElement | null>;
  /** The table's header row. */
  head: RefObject<HTMLTableRowElement | null>;
  /** The strip's scroller (its table's `col`s take the header's widths). */
  strip: RefObject<HTMLElement | null>;
}) {
  // Offsets, widths and whether the columns stick.
  useEffect(() => {
    const box = wrap.current;
    const scroll = scroller.current;
    const row = head.current;
    if (!box || !scroll || !row) return;
    const measure = () => {
      const cells = [...row.cells];
      const widths = cells.map(c => c.getBoundingClientRect().width);
      let at = 0;
      let start = 0;
      cells.forEach((c, i) => {
        const stick = c.dataset.stick;
        if (!stick || stick.startsWith("r")) return;
        box.style.setProperty(`--stick-${stick}`, `${at}px`);
        at += widths[i];
        start = at;
      });
      at = 0;
      let end = 0;
      [...cells].reverse().forEach((c, j) => {
        const stick = c.dataset.stick;
        if (!stick?.startsWith("r")) return;
        box.style.setProperty(`--stick-${stick}`, `${at}px`);
        at += widths[cells.length - 1 - j];
        end = at;
      });
      box.style.setProperty("--stick-start", `${start}px`);
      box.style.setProperty("--stick-end", `${end}px`);
      const overflow = scroll.scrollWidth > scroll.clientWidth + 1;
      box.toggleAttribute("data-sticky", !overflow || scroll.clientWidth - start - end >= MIDDLE_MIN);
      // The strip: the same widths, the same total.
      const table = strip.current?.querySelector("table");
      const real = row.closest("table");
      if (table && real) {
        table.style.width = `${real.getBoundingClientRect().width}px`;
        table.querySelectorAll("col").forEach((col, i) => {
          col.style.width = `${widths[i] ?? 0}px`;
        });
      }
    };
    const ro = new ResizeObserver(measure);
    for (const c of row.cells) ro.observe(c);
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [wrap, scroller, head, strip]);

  // Something scrolled under the frozen edges: two sentinels at the ends of the scrolled content.
  useEffect(() => {
    const box = wrap.current;
    const scroll = scroller.current;
    if (!box || !scroll) return;
    const start = scroll.querySelector("[data-edge=start]");
    const end = scroll.querySelector("[data-edge=end]");
    if (!start || !end) return;
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) box.toggleAttribute(e.target === start ? "data-under-start" : "data-under-end", e.intersectionRatio < 1);
      },
      { root: scroll, threshold: 1 }
    );
    io.observe(start);
    io.observe(end);
    return () => io.disconnect();
  }, [wrap, scroller]);

  // The header row under the bars: the strip shows. The bars' bottom is the strip's own sticky top.
  useEffect(() => {
    const box = wrap.current;
    const row = head.current;
    const bar = strip.current?.parentElement;
    if (!box || !row || !bar) return;
    let io: IntersectionObserver | null = null;
    const watch = () => {
      io?.disconnect();
      const main = document.getElementById("main");
      const root = main && main.scrollHeight > main.clientHeight + 1 ? main : null;
      const top = parseFloat(getComputedStyle(bar).top) || 0;
      io = new IntersectionObserver(
        ([e]) => {
          const rootTop = e.rootBounds?.top ?? 0;
          box.toggleAttribute("data-stuck", e.intersectionRatio < 1 && e.boundingClientRect.top < rootTop);
        },
        { root, rootMargin: `-${Math.round(top)}px 0px 0px 0px`, threshold: [0, 1] }
      );
      io.observe(row);
    };
    watch();
    // The bars' height follows the window's width (a header that wraps): watched again on a resize.
    addEventListener("resize", watch);
    return () => {
      removeEventListener("resize", watch);
      io?.disconnect();
    };
  }, [wrap, head, strip]);

  // The strip follows the table sideways; a control focused under a frozen column comes out from under it.
  useEffect(() => {
    const box = wrap.current;
    const scroll = scroller.current;
    if (!box || !scroll) return;
    const follow = () => {
      if (strip.current) strip.current.scrollLeft = scroll.scrollLeft;
    };
    const onFocus = (event: FocusEvent) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !box.hasAttribute("data-sticky") || el.closest("[data-stick]")) return;
      const rect = el.getBoundingClientRect();
      const port = scroll.getBoundingClientRect();
      const style = getComputedStyle(box);
      const left = port.left + scroll.clientLeft + (parseFloat(style.getPropertyValue("--stick-start")) || 0) + (parseFloat(getComputedStyle(scroll).paddingLeft) || 0);
      const right = port.left + scroll.clientLeft + scroll.clientWidth - (parseFloat(style.getPropertyValue("--stick-end")) || 0) - (parseFloat(getComputedStyle(scroll).paddingRight) || 0);
      const delta = rect.left < left ? rect.left - left - 8 : rect.right > right ? rect.right - right + 8 : 0;
      if (delta) scroll.scrollBy({ left: delta });
    };
    scroll.addEventListener("scroll", follow, { passive: true });
    scroll.addEventListener("focusin", onFocus);
    return () => {
      scroll.removeEventListener("scroll", follow);
      scroll.removeEventListener("focusin", onFocus);
    };
  }, [wrap, scroller, strip]);
}
