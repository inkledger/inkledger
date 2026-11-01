import { useEffect, useRef, type ReactNode } from "react";
import { beginWorkspaceTask } from "./client";

const editable = "input, textarea, select, [contenteditable='true']";

/** What the user typed is still there: the field is on the page and not empty. */
function holdsText(element: HTMLElement | null): boolean {
  if (!element?.isConnected) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value !== "";
  return (element.textContent ?? "") !== "";
}

/**
 * While someone types in a field inside, a layout is not activated (T-01). The task ends when focus
 * leaves the fields, unless what was typed is still there: then it ends once that field is emptied
 * or gone (a dialog closed by its Cancel button, not only by Escape or submit).
 */
export function WorkspaceInteractionBoundary({ children }: { children: ReactNode }) {
  const end = useRef<(() => void) | null>(null);
  const typed = useRef<HTMLElement | null>(null);
  const recheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRecheck = () => {
    if (recheck.current) clearTimeout(recheck.current);
    recheck.current = null;
  };
  const finish = () => {
    clearRecheck();
    end.current?.();
    end.current = null;
    typed.current = null;
  };
  const start = () => {
    clearRecheck();
    if (!end.current) end.current = beginWorkspaceTask();
  };
  const stop = (force = false) => {
    if (force || !holdsText(typed.current)) {
      finish();
      return;
    }
    // Still holding text: look again shortly, so a dialog that went away releases the task.
    clearRecheck();
    recheck.current = setTimeout(() => stop(), 500);
  };
  useEffect(() => () => {
    if (recheck.current) clearTimeout(recheck.current);
    end.current?.();
    end.current = null;
  }, []);
  return (
    <div
      className="contents"
      onFocusCapture={event => { if ((event.target as HTMLElement).matches?.(editable)) start(); }}
      onInput={event => {
        if ((event.target as HTMLElement).matches?.(editable)) {
          typed.current = event.target as HTMLElement;
          start();
        }
      }}
      onBlurCapture={event => {
        if ((event.target as HTMLElement).matches?.(editable) && !(event.relatedTarget as HTMLElement | null)?.matches?.(editable)) stop();
      }}
      onSubmit={() => queueMicrotask(() => stop(true))}
      onKeyDown={event => { if (event.key === "Escape") stop(true); }}
    >
      {children}
    </div>
  );
}
