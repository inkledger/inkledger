import { useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { todoFloat, todoFloatFocus } from "@/lib/flag";
import { trpc } from "@/lib/trpc";

/** Where the TODO list lives (Settings → TODO): its page in the menu, the floating widget ("d"), the bottom-right hot corner. */
export type TodoSurfaces = { menu: boolean; widget: boolean; corner: boolean };
const ALL: TodoSurfaces = { menu: true, widget: true, corner: true };

let surfaces = ALL;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The user's surfaces, as their settings say (all of them until read). */
export function useTodoSurfaces(): TodoSurfaces {
  const s = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data;
  return s ? { menu: s.todosInMenu === 1, widget: s.todosWidget === 1, corner: s.todosHotCorner === 1 } : ALL;
}

/** The surfaces as the layout last gave them: for "d", the palette and the buttons outside React. */
export const useTodoSurfacesNow = (): TodoSurfaces => useSyncExternalStore(subscribe, () => surfaces, () => surfaces);

let go: ((to: string) => void) | null = null;

/** The layout's part: the settings and the router, for "d", the hot corner and the palette. */
export function useTodoWiring() {
  const s = useTodoSurfaces();
  const navigate = useNavigate();
  useEffect(() => {
    if (s.menu === surfaces.menu && s.widget === surfaces.widget && s.corner === surfaces.corner) return;
    surfaces = s;
    listeners.forEach(l => l());
  }, [s.menu, s.widget, s.corner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    go = to => void navigate(to);
    return () => {
      go = null;
    };
  }, [navigate]);
}

/** Where the list opens from here: the widget when on, else its page (not when already there), else nowhere. */
export function todoTarget(pathname: string, s: TodoSurfaces): "float" | "page" | null {
  if (pathname === "/todos") return null;
  if (s.widget) return "float";
  if (s.menu) return "page";
  return null;
}

/** The widget gives way on the list's own page. */
export const todoFloatHidden = (pathname: string) => pathname === "/todos";

/** "d", the palette, the buttons: show or hide the list where it lives. */
export function toggleTodos(pathname = window.location.pathname) {
  const target = todoTarget(pathname, surfaces);
  if (target === "float") {
    const opening = !todoFloat.get();
    todoFloatFocus.set(opening);
    todoFloat.set(opening);
  } else if (target === "page") go?.("/todos");
}

/** Show the list (never closing it): the hot corner, "Open" in a reminder. */
export function showTodos(pathname = window.location.pathname) {
  const target = todoTarget(pathname, surfaces);
  if (target === "float") {
    // Already open: nothing to focus (a flag left set would take the focus later).
    if (todoFloat.get()) return;
    todoFloatFocus.set(true);
    todoFloat.set(true);
  } else if (target === "page") go?.("/todos");
}

/** Whether "d" or a button has somewhere to open the list from here. */
export const canShowTodos = (pathname = window.location.pathname) => todoTarget(pathname, surfaces) !== null;

/** The same, as a hook (re-rendered when the settings change). */
export function useTodoTarget(pathname: string) {
  return todoTarget(pathname, useTodoSurfacesNow());
}

/** On a phone: the list as a sheet from the bottom (More's tile, the header button), whatever the widget setting. */
export function openTodosSheet() {
  if (todoFloat.get()) return;
  todoFloatFocus.set(true);
  todoFloat.set(true);
}
