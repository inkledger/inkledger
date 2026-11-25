import { useEffect, type RefObject } from "react";

/**
 * The middle columns keep at least this much room. Narrower, the frozen end (the timer) scrolls with them;
 * the frozen start (what names the row) always stays, and the list is never narrower than it plus this
 * (`--list-min`, the splitter's limit).
 */
const MIDDLE_MIN = 160;

/**
 * A table with frozen columns at both ends (cells marked `data-stick="1".."n"` from the left, `"r1".."rn"`
 * from the right) and a header strip that stays under the page's bars while its header row has scrolled
 * away (docs/design-system.md §7). Everything is written to the DOM directly, never through React state:
 * - the frozen cells' offsets and the strip's column widths, from a ResizeObserver on the header row;
 * - whether the end's columns stick too (`data-free-end` on the wrapper when the middle would lose its room);
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
    // Written only when changed: these variables are inherited by every cell, and a drag of the preview
    // resizes the table every frame while the frozen columns keep their widths.
    const put = (el: HTMLElement, name: string, value: string) => {
      if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
    };
    const measure = () => {
      const cells = [...row.cells];
      const widths = cells.map(c => c.getBoundingClientRect().width);
      let at = 0;
      let start = 0;
      cells.forEach((c, i) => {
        const stick = c.dataset.stick;
        if (!stick || stick.startsWith("r")) return;
        put(box, `--stick-${stick}`, `${at}px`);
        at += widths[i];
        start = at;
      });
      at = 0;
      let end = 0;
      [...cells].reverse().forEach((c, j) => {
        const stick = c.dataset.stick;
        if (!stick?.startsWith("r")) return;
        put(box, `--stick-${stick}`, `${at}px`);
        at += widths[cells.length - 1 - j];
        end = at;
      });
      const overflow = scroll.scrollWidth > scroll.clientWidth + 1;
      const freeEnd = overflow && scroll.clientWidth - start - end < MIDDLE_MIN;
      box.toggleAttribute("data-sticky", true);
      box.toggleAttribute("data-free-end", freeEnd);
      put(box, "--stick-start", `${start}px`);
      put(box, "--stick-end", `${freeEnd ? 0 : end}px`);
      // The strip: the same widths, the same total.
      const table = strip.current?.querySelector("table");
      const real = row.closest("table");
      if (table && real) {
        put(table, "width", `${real.getBoundingClientRect().width}px`);
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
    let was: [Element | null, number] | null = null;
    const watch = () => {
      const main = document.getElementById("main");
      const root = main && main.scrollHeight > main.clientHeight + 1 ? main : null;
      const top = parseFloat(getComputedStyle(bar).top) || 0;
      // The same root and line: the observer holds (a bar resized only in width, every frame of a drag).
      if (was && was[0] === root && Math.abs(was[1] - top) < 0.5) return;
      was = [root, top];
      io?.disconnect();
      io = new IntersectionObserver(
        ([e]) => {
          const rootTop = e.rootBounds?.top ?? 0;
          box.toggleAttribute("data-stuck", e.intersectionRatio < 1 && e.boundingClientRect.top < rootTop);
        },
        { root, rootMargin: `-${Math.round(top)}px 0px 0px 0px`, threshold: [0, 1] }
      );
      io.observe(row);
    };
    // The bars' height changes (filters that wrap when the preview widens, a narrower window): watched again
    // then (the first call comes at once).
    const bars = new ResizeObserver(watch);
    for (const el of document.querySelectorAll("[data-chrome]")) bars.observe(el);
    bars.observe(document.documentElement);
    return () => {
      bars.disconnect();
      io?.disconnect();
    };
  }, [wrap, head, strip]);

  // One column template and one sideways scroll for every table of the group (the page's favourites and the rest).
  useEffect(() => {
    const box = wrap.current;
    const scroll = scroller.current;
    if (!box || !scroll) return;
    return joinGroup(box.parentElement?.closest<HTMLElement>("[data-table-group]") ?? box, box, scroll);
  }, [wrap, scroller]);

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
      if (!(el instanceof HTMLElement) || !box.hasAttribute("data-sticky")) return;
      if (el.closest("[data-stick]")) {
        // A frozen control is always in view: undo the browser's own scroll-into-view (it runs after focusin).
        const kept = scroll.scrollLeft;
        requestAnimationFrame(() => {
          if (scroll.scrollLeft !== kept) scroll.scrollLeft = kept;
        });
        return;
      }
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

/** The title's least width (two lines, clamped): the column that takes what the others leave. */
const TITLE_MIN = 160;
const TITLE_COLUMN = 3;

type Group = { tables: Map<HTMLElement, HTMLElement>; ro: ResizeObserver; mo: MutationObserver; measure: () => void; leader?: HTMLElement | null };
const groups = new WeakMap<HTMLElement, Group>();

/**
 * Tables that share their columns (`[data-table-group]` around them): each column as wide as the widest content
 * (`[data-col]`, drawn at its own width) of any of their cells, plus the cell's padding, written once on the group
 * as `--col-N`; the tables' least width as `--cols-min`. Measured when a content changes size (a timer starts,
 * a page of rows arrives), never on scroll. Their scrollers move sideways together.
 */
function joinGroup(root: HTMLElement, box: HTMLElement, scroll: HTMLElement): () => void {
  let group = groups.get(root);
  if (!group) {
    const tables = new Map<HTMLElement, HTMLElement>();
    const measure = () => {
      const widest: number[] = [];
      for (const wrap of tables.keys()) {
        const table = wrap.querySelector<HTMLTableElement>("table[data-slot=table]");
        if (!table) continue;
        const pads = [...(table.tHead?.rows[0]?.cells ?? [])].map(c => {
          const st = getComputedStyle(c);
          return (parseFloat(st.paddingLeft) || 0) + (parseFloat(st.paddingRight) || 0);
        });
        for (const row of table.rows)
          [...row.cells].forEach((cell, i) => {
            const content = cell.querySelector(":scope > :is([data-col], button)");
            if (!content || i === TITLE_COLUMN) return;
            widest[i] = Math.max(widest[i] ?? 0, Math.ceil(content.getBoundingClientRect().width + (pads[i] ?? 0)));
          });
      }
      let sum = 0;
      widest.forEach((w, i) => {
        if (w === undefined) return;
        sum += w;
        const value = `${w}px`;
        if (root.style.getPropertyValue(`--col-${i}`) !== value) root.style.setProperty(`--col-${i}`, value);
      });
      const min = `${Math.ceil(sum + TITLE_MIN)}px`;
      if (root.style.getPropertyValue("--cols-min") !== min) root.style.setProperty("--cols-min", min);
      // The list's least width, for the split around it (`[data-list-min-host]`, its first child the list): the
      // frozen start, one scrolled column's room, and what the list puts around its table.
      const host = root.closest<HTMLElement>("[data-list-min-host]");
      const wrap = tables.keys().next().value;
      const scroll = wrap && tables.get(wrap);
      const list = host?.firstElementChild;
      if (host && scroll && list) {
        const st = getComputedStyle(scroll);
        const around = list.getBoundingClientRect().width - (scroll.clientWidth - (parseFloat(st.paddingLeft) || 0) - (parseFloat(st.paddingRight) || 0));
        const startCols = [0, 1, 2].reduce((s, i) => s + (widest[i] ?? 0), 0);
        // Room for one column, and for the end's (the timer, the actions) once they scroll with the middle.
        const room = Math.max(MIDDLE_MIN, (widest[9] ?? 0) + (widest[10] ?? 0));
        const listMin = `${Math.ceil(startCols + TITLE_MIN + room + around)}px`;
        if (host.style.getPropertyValue("--list-min") !== listMin) host.style.setProperty("--list-min", listMin);
      }
    };
    const ro = new ResizeObserver(measure);
    const watchAll = () => {
      for (const wrap of tables.keys()) for (const el of wrap.querySelectorAll("table[data-slot=table] [data-col], table[data-slot=table] th > button")) ro.observe(el);
    };
    const mo = new MutationObserver(() => {
      watchAll();
      measure();
    });
    group = { tables, ro, mo, measure };
    groups.set(root, group);
  }
  const g = group;
  // Sideways together: a scroll of one is set on the others (the same value fires no further change).
  // A table whose sideways room is a pixel or two shorter clamps the value it is given: its own scroll event must not
  // echo that clamped value back to the table that led (it would move the leader by those pixels).
  const follow = () => {
    if (g.leader && g.leader !== scroll) return;
    g.leader = scroll;
    for (const other of g.tables.values()) if (other !== scroll && other.scrollLeft !== scroll.scrollLeft) other.scrollLeft = scroll.scrollLeft;
    requestAnimationFrame(() => {
      if (g.leader === scroll) g.leader = null;
    });
  };
  const first = g.tables.values().next().value;
  g.tables.set(box, scroll);
  if (first) scroll.scrollLeft = first.scrollLeft;
  scroll.addEventListener("scroll", follow, { passive: true });
  const body = box.querySelector("table[data-slot=table]");
  if (body) g.mo.observe(body, { childList: true, subtree: true });
  for (const el of box.querySelectorAll("table[data-slot=table] [data-col], table[data-slot=table] th > button")) g.ro.observe(el);
  g.measure();
  return () => {
    scroll.removeEventListener("scroll", follow);
    g.tables.delete(box);
    for (const el of box.querySelectorAll("[data-col], th > button")) g.ro.unobserve(el);
    if (g.tables.size === 0) {
      g.ro.disconnect();
      g.mo.disconnect();
      groups.delete(root);
    } else g.measure();
  };
}
