import { useSyncExternalStore } from "react";

/** An issue chosen in the picker: its connection is known unless a key was typed. */
export type PickedIssue = { key: string; connectionId?: number };

type State = {
  open: boolean;
  /** Pick mode: the chosen issue goes here instead of starting a timer. */
  onPick?: (pick: PickedIssue) => void;
  placeholder?: string;
};

let state: State = { open: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** Open/close the "start a timer" picker (key "t") from anywhere. */
export const quickStart = {
  set(open: boolean) {
    state = { open };
    emit();
  },
  /** Reuse the picker to choose an issue for something else. */
  pick(onPick: (pick: PickedIssue) => void, placeholder: string) {
    state = { open: true, onPick, placeholder };
    emit();
  },
};

function useQuickStartState(): State {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state
  );
}

export function useQuickStartOpen(): boolean {
  return useQuickStartState().open;
}

export function useQuickStartPick(): Pick<State, "onPick" | "placeholder"> {
  const { onPick, placeholder } = useQuickStartState();
  return { onPick, placeholder };
}
