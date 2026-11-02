import { createStore } from "@/lib/store";

/** An issue chosen in the picker: its connection is known unless a key was typed. */
export type PickedIssue = { key: string; connectionId?: number };

type State = {
  open: boolean;
  /** Pick mode: the chosen issue goes here instead of starting a timer. */
  onPick?: (pick: PickedIssue) => void;
  placeholder?: string;
};

const state = createStore<State>({ open: false });

/** Open/close the "start a timer" picker (key "t") from anywhere. */
export const quickStart = {
  set(open: boolean) {
    state.set({ open });
  },
  /** Reuse the picker to choose an issue for something else. */
  pick(onPick: (pick: PickedIssue) => void, placeholder: string) {
    state.set({ open: true, onPick, placeholder });
  },
};

export function useQuickStartOpen(): boolean {
  return state.use().open;
}

export function useQuickStartPick(): Pick<State, "onPick" | "placeholder"> {
  const { onPick, placeholder } = state.use();
  return { onPick, placeholder };
}
