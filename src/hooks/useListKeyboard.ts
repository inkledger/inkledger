import { useEffect, useRef, useState } from "react";
import { inFloat, isDialogOpen, isTyping } from "@/lib/dom";
import { hotkeySequence } from "@/lib/hotkeySequence";

const isControl = (t: EventTarget | null) =>
  t instanceof HTMLElement && t.closest("button, a, [role=button]") !== null;

export type ListKeyActions = Partial<
  Record<"open" | "s" | "h" | "t" | "c" | "b", (key: string) => void>
>;

/**
 * Linear-style list keys: j / k move a selection over `keys`, Enter opens,
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
        // Enter on a focused control activates the control, not the row.
        if (e.key === "Enter" && isControl(e.target)) return;
        const name = e.key === "Enter" ? "open" : e.key;
        const fn = act[name as keyof ListKeyActions];
        if (fn) handle(() => fn(sel));
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Keep the selected row in view.
  useEffect(() => {
    if (!selected) return;
    document
      .querySelector(`[data-issue-id="${CSS.escape(selected)}"]:not([hidden])`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // A row that left the list (hidden, filtered) drops the selection.
  const current = selected && keys.includes(selected) ? selected : null;
  return { selected: current, select: setSelected };
}
