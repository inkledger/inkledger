import { createStore } from "@/lib/store";
import type { TodoLink } from "@/components/todo/MakeTodo";

/** "Add a TODO…" from a card's or a row's menu: one dialog for the whole app, asked for here. */
type Asked = { link: TodoLink; initial: string } | null;
const asked = createStore<Asked>(null);

export const makeTodo = {
  ask: (link: TodoLink, initial = "") => asked.set({ link, initial }),
  close: () => asked.set(null),
  use: asked.use,
};
