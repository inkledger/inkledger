import { useEffect, useRef, useState } from "react";
import { inFloat, isDialogOpen, isTyping } from "@/lib/dom";
import { hotkeySequence } from "@/lib/hotkeySequence";

const isControl = (t: EventTarget | null) =>
  t instanceof HTMLElement && t.closest("button, a, [role=button]") !== null;

export type ListKeyActions = Partial<
  Record<"open" | "peek" | "s" | "h" | "t" | "c" | "b" | "m" | "x", (key: string) => void>
>;

/**
 * Linear-style list keys: j / k move a selection over `keys`, Enter opens, Space peeks (a quick look),
 * single letters act on the selected row. Runs before the global shortcuts
 * (capture phase) so "t" means "timer on this row" while a row is selected.
 */
export function useListKeyboard(keys: string[], actions: ListKeyActions) {
  const [selected, setSelected] = useState<string | null>(null);
  const state = useRef({ keys, actions, selected });
  useEffect(() => {
    state.current = { keys, actions, selected };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || isDialogOpen() || inFloat(e.target)) return;
      // Open selects / menus / popovers own the keyboard (j, k, Esc, Enter).
      if (
        document.querySelector(
          "[role=listbox], [role=menu], [data-radix-popper-content-wrapper]"
        )
      )
        return;
      // "g t", "g b"…: the global sequence wins over row actions.
      if (hotkeySequence.pending()) return;
      const { keys: list, actions: act, selected: sel } = state.current;
      const at = sel ? list.indexOf(sel) : -1;
      const handle = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (e.key === "j" || e.key === "ArrowDown") {
        if (e.key === "ArrowDown" && at < 0) return;
        handle(() =>
          setSelected(list[Math.min(list.length - 1, at + 1)] ?? null)
        );
      } else if (e.key === "k" || e.key === "ArrowUp") {
        if (e.key === "ArrowUp" && at < 0) return;
        handle(() => setSelected(list[Math.max(0, at - 1)] ?? null));
      } else if (e.key === "Escape" && sel) {
        handle(() => setSelected(null));
      } else if (sel && at >= 0) {
        // Enter and Space on a focused control activate the control, not the row.
        if ((e.key === "Enter" || e.key === " ") && isControl(e.target)) return;
        const name = e.key === "Enter" ? "open" : e.key === " " ? "peek" : e.key;
        const fn = act[name as keyof ListKeyActions];
        if (fn) handle(() => fn(sel));
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Keep the selected row in view, and out from under the sticky bars (page header, filters): "nearest"
  // alone stops at the scroller's edge, which those bars cover.
  useEffect(() => {
    if (!selected) return;
    const row = document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(selected)}"]:not([hidden])`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    const cover = coveringBarBottom(row);
    if (cover === null) return;
    const delta = row.getBoundingClientRect().top - cover - 4;
    const scroller = row.closest<HTMLElement>("#main");
    if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollBy({ top: delta });
    else window.scrollBy({ top: delta });
  }, [selected]);

  // A row that left the list (hidden, filtered) drops the selection.
  const current = selected && keys.includes(selected) ? selected : null;
  return { selected: current, select: setSelected };
}

/** The bottom of a sticky or fixed bar drawn over the top of `row`, or null when nothing covers it. */
function coveringBarBottom(row: HTMLElement): number | null {
  const box = row.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + Math.min(box.width / 2, 40), Math.max(0, box.top) + 1);
  if (!hit || row.contains(hit)) return null;
  for (let bar: Element | null = hit; bar && bar !== document.body; bar = bar.parentElement) {
    const position = getComputedStyle(bar).position;
    if (position === "sticky" || position === "fixed") return bar.getBoundingClientRect().bottom;
  }
  return null;
}
