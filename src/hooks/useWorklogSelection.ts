import { useState } from "react";

/**
 * Set of selected worklog ids, scoped to `scope` (e.g. view + period): when
 * the scope changes the selection reads as empty, no effect needed.
 */
export function useWorklogSelection(scope: string) {
  const [state, setState] = useState<{ scope: string; ids: Set<number> }>({
    scope,
    ids: new Set(),
  });
  const selected = state.scope === scope ? state.ids : new Set<number>();

  return {
    selected,
    toggle: (id: number) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setState({ scope, ids: next });
    },
    setAll: (ids: number[]) => setState({ scope, ids: new Set(ids) }),
    /** A group in or out (a day's entries), the other choices kept. */
    selectMany: (ids: number[], on: boolean) => {
      const next = new Set(selected);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      setState({ scope, ids: next });
    },
    clear: () => setState({ scope, ids: new Set() }),
  };
}
