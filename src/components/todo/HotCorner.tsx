import { useEffect, useRef, useState } from "react";
import { todoFloat } from "@/lib/flag";
import { isDialogOpen } from "@/lib/dom";
import { showTodos, useTodoSurfacesNow } from "@/hooks/useTodoPanel";

/** How long the pointer rests in the corner before the list opens. */
const DWELL_MS = 300;

/**
 * The bottom-right corner opens the TODO list, as Quick Note does on a Mac:
 * a few pixels, a short rest of the pointer (a pass on the way elsewhere
 * opens nothing). Only with a fine pointer that hovers; never while a button
 * is held (a drag), a dialog is open, the list is already open, or toasts sit
 * in that corner. "d" is the same for the keyboard: the corner is hidden from
 * assistive tech.
 */
export function HotCorner() {
  const { corner, widget, menu } = useTodoSurfacesNow();
  const [fine, setFine] = useState(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Switched off during the rest: the waiting timer opens nothing.
  const on = corner && (widget || menu);
  useEffect(() => {
    if (!on && timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, [on]);
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const on = () => setFine(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  if (!on || !fine) return null;
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <div
      aria-hidden
      data-todo-corner
      className="fixed bottom-0 right-0 z-50 h-1.5 w-1.5"
      onPointerEnter={e => {
        if (e.buttons !== 0 || isDialogOpen() || todoFloat.get()) return;
        if (document.querySelector("[data-sonner-toast]")) return;
        cancel();
        timer.current = setTimeout(() => {
          timer.current = null;
          if (isDialogOpen() || todoFloat.get() || document.querySelector("[data-sonner-toast]")) return;
          showTodos();
        }, DWELL_MS);
      }}
      onPointerLeave={cancel}
      onPointerDown={cancel}
    />
  );
}
