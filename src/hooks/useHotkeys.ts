import { useEffect } from "react";
import { useNavigate } from "react-router";
import { isDialogOpen, isTyping } from "@/lib/dom";
import { shortcutsHelp } from "@/lib/shortcuts";
import { sidebar } from "@/hooks/useSidebar";
import { quickStart } from "@/lib/quickStart";
import { createIssueDialog, focusMode, notificationCenter, screensaver } from "@/lib/flag";
import { hotkeySequence } from "@/lib/hotkeySequence";
import { togglePinboard } from "@/hooks/usePinboardPanel";
import { toggleTodos } from "@/hooks/useTodoPanel";

const SEQUENCES: Record<string, string> = {
  "g d": "/",
  "g i": "/issues",
  "g n": "/notes",
  "g t": "/timesheet",
  "g b": "/board",
  "g r": "/reports",
};

/** GitHub-style keyboard sequences: press "g" then a letter to navigate. */
export function useHotkeys() {
  const navigate = useNavigate();
  useEffect(() => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // handled by a page (e.g. list keys)
      // Back / forward: ⌘[ ⌘] (by physical key: Italian layouts) or Alt+← →
      // outside text fields. The native window has no browser buttons.
      const step =
        (e.metaKey || e.ctrlKey) && !e.altKey && e.code === "BracketLeft"
          ? -1
          : (e.metaKey || e.ctrlKey) && !e.altKey && e.code === "BracketRight"
            ? 1
            : e.altKey && !e.metaKey && !isTyping(e.target) && e.key === "ArrowLeft"
              ? -1
              : e.altKey && !e.metaKey && !isTyping(e.target) && e.key === "ArrowRight"
                ? 1
                : 0;
      if (step) {
        e.preventDefault();
        void navigate(step);
        return;
      }
      if (isTyping(e.target) || isDialogOpen()) return;
      // "[" by physical key: on Italian layouts it needs Option / AltGr.
      if (e.code === "BracketLeft" && !e.metaKey) {
        e.preventDefault();
        sidebar.toggle();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        shortcutsHelp.set(true);
        return;
      }
      if (e.key === "n" && !buffer.endsWith("g")) {
        e.preventDefault();
        buffer = "";
        notificationCenter.set(true);
        return;
      }
      // "i" creates an issue, unless it completes "g i" (go to issues).
      if (e.key === "i" && !buffer.endsWith("g")) {
        e.preventDefault();
        buffer = "";
        createIssueDialog.set(true);
        return;
      }
      if (e.key === "f" && !buffer.endsWith("g")) {
        e.preventDefault();
        buffer = "";
        focusMode.set(true);
        return;
      }
      if (e.key === "z" && !buffer.endsWith("g")) {
        e.preventDefault();
        buffer = "";
        screensaver.set(true);
        return;
      }
      if (e.key === "p" && !buffer.endsWith("g")) {
        e.preventDefault();
        buffer = "";
        togglePinboard();
        return;
      }
      // "d": the TODO list, unless it completes "g d" (go to the dashboard).
      if (e.key === "d" && !buffer.endsWith("g")) {
        e.preventDefault();
        buffer = "";
        toggleTodos();
        return;
      }
      // "t" starts a timer, unless it completes "g t" (go to timesheet).
      if (e.key === "t" && !buffer.endsWith("g")) {
        e.preventDefault();
        buffer = "";
        quickStart.set(true);
        return;
      }
      buffer = `${buffer} ${e.key}`.trim().slice(-3);
      const target = SEQUENCES[buffer];
      clearTimeout(timer);
      if (target) {
        // Consumed: page handlers listening after us must ignore this key.
        e.preventDefault();
        buffer = "";
        hotkeySequence.clear();
        void navigate(target);
        return;
      }
      if (e.key === "g") hotkeySequence.start();
      else hotkeySequence.clear();
      timer = setTimeout(() => {
        buffer = "";
        hotkeySequence.clear();
      }, 1000);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [navigate]);
}

/**
 * The mouse's back/forward buttons in the native window (browsers handle
 * them by themselves; doing it here too would go back twice).
 */
export function useMouseHistoryButtons(enabled: boolean) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    const onUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      void navigate(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [enabled, navigate]);
}
