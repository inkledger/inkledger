import { useSyncExternalStore } from "react";
import { MOD_KEY, PALETTE_SHORTCUT } from "@/lib/dom";
import { t } from "@/i18n";

/** Alt+Shift as the platform writes it. */
const ALT_SHIFT = MOD_KEY === "⌘" ? ["⌥", "⇧"] : ["Alt", "Shift"];

/** Every keyboard shortcut of the app (source for the "?" help dialog); "p" while the pinboard lives somewhere, "d" the TODO list. */
export function shortcuts({ pinboard = true, todos = true }: { pinboard?: boolean; todos?: boolean } = {}): {
  group: string;
  items: { keys: string[]; label: string }[];
}[] {
  return [
    {
      group: t("ui.shortcuts.general"),
      items: [
        { keys: ["t"], label: t("ui.shortcuts.startTimer") },
        { keys: ["f"], label: t("ui.shortcuts.focus") },
        { keys: ["z"], label: t("ui.shortcuts.screensaver") },
        { keys: ["n"], label: t("ui.shortcuts.notifications") },
        { keys: ["i"], label: t("ui.shortcuts.newIssue") },
        ...(pinboard
          ? [
              { keys: ["p"], label: t("ui.shortcuts.pinboard") },
              { keys: ["/"], label: t("ui.shortcuts.pinboardSearch") },
            ]
          : []),
        ...(todos
          ? [
              { keys: ["d"], label: t("ui.shortcuts.todos") },
              { keys: ["/"], label: t("ui.shortcuts.todosCapture") },
            ]
          : []),
        { keys: [PALETTE_SHORTCUT], label: t("ui.shortcuts.search") },
        { keys: ["?"], label: t("ui.shortcuts.show") },
        { keys: ["["], label: t("ui.shortcuts.sidebar") },
      ],
    },
    {
      group: t("ui.shortcuts.navigation"),
      items: [
        { keys: ["g", "d"], label: t("ui.nav.dashboard") },
        { keys: ["g", "b"], label: t("ui.nav.board") },
        { keys: ["g", "i"], label: t("ui.nav.issues") },
        { keys: ["g", "e"], label: t("ui.nav.desk") },
        { keys: ["g", "n"], label: t("ui.nav.notes") },
        { keys: ["g", "t"], label: t("ui.nav.timesheet") },
        { keys: ["g", "r"], label: t("ui.nav.reports") },
      ],
    },
    {
      group: t("ui.shortcuts.list"),
      items: [
        { keys: ["j", "k"], label: t("ui.shortcuts.nextRow") },
        { keys: [t("ui.keys.enter")], label: t("ui.shortcuts.openIssue") },
        { keys: ["t"], label: t("ui.shortcuts.startRow") },
        { keys: ["s", "h"], label: t("ui.shortcuts.favHide") },
        { keys: ["x"], label: t("ui.shortcuts.pickRow") },
        { keys: ["Esc"], label: t("ui.shortcuts.clearSelection") },
      ],
    },
    {
      group: t("ui.shortcuts.issue"),
      items: [
        { keys: ["l"], label: t("ui.shortcuts.logTime") },
        { keys: ["s"], label: t("ui.shortcuts.toggleFav") },
        { keys: ["h"], label: t("ui.shortcuts.toggleHide") },
        { keys: ["c"], label: t("ui.shortcuts.copyKey") },
        { keys: ["b"], label: t("ui.shortcuts.copyBranch") },
        { keys: ["m"], label: t("ui.shortcuts.copyCommit") },
        { keys: [...ALT_SHIFT, "← ↑ → ↓"], label: t("ui.shortcuts.sendToDesk") },
        {
          keys: [PALETTE_SHORTCUT.startsWith("⌘") ? "⌘" : "Ctrl", t("ui.keys.enter")],
          label: t("ui.shortcuts.postComment"),
        },
      ],
    },
    {
      group: t("ui.shortcuts.desk"),
      items: [
        { keys: ["1–6"], label: t("ui.shortcuts.focusPane") },
        { keys: ["x"], label: t("ui.shortcuts.closePane") },
        { keys: ["Esc"], label: t("ui.shortcuts.restorePane") },
        { keys: [...ALT_SHIFT, "← ↑ → ↓"], label: t("ui.shortcuts.snapPane") },
        { keys: [t("ui.keys.space")], label: t("ui.shortcuts.movePane") },
        { keys: ["⇧", t("ui.keys.click")], label: t("ui.shortcuts.openBeside") },
        { keys: ["a"], label: t("ui.shortcuts.askAi") },
      ],
    },
  ];
}

let open = false;
const listeners = new Set<() => void>();

export const shortcutsHelp = {
  set: (value: boolean) => {
    open = value;
    listeners.forEach(l => l());
  },
};

export function useShortcutsHelpOpen(): boolean {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => open
  );
}
