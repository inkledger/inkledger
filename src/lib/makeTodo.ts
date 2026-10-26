import { useSyncExternalStore } from "react";
import type { TodoLink } from "@/components/todo/MakeTodo";

/** "Add a TODO…" from a card's or a row's menu: one dialog for the whole app, asked for here. */
type Asked = { link: TodoLink; initial: string } | null;
let asked: Asked = null;
const listeners = new Set<() => void>();

export const makeTodo = {
  ask: (link: TodoLink, initial = "") => {
    asked = { link, initial };
    listeners.forEach(l => l());
  },
  close: () => {
    asked = null;
    listeners.forEach(l => l());
  },
  use: (): Asked =>
    useSyncExternalStore(
      l => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => asked,
      () => asked
    ),
};
