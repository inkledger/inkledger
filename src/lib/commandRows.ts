import { defaultFilter } from "cmdk";

/**
 * A searchable list as rows (src/components/app/VirtualCommand.tsx draws only the
 * ones in view): sections of options, filtered and ordered as cmdk 1.1.1 does, so
 * a list moved off cmdk keeps its results.
 * - Ranking: cmdk's own `defaultFilter` (its command-score) on the option's text
 *   and keywords, trimmed; the query as typed. Score 0: not shown.
 * - With a query, options sort by score inside their section (ties keep their
 *   order); sections stay in their order (cmdk 1.1.1 never reorders its groups).
 * - `forceShow` (cmdk's forceMount): always shown, not counted for "No results".
 */
export type CommandOption = { id: string; search: string; keywords?: readonly string[]; forceShow?: boolean };
export type CommandSection = { id: string; heading?: string; options: readonly CommandOption[] };

export type CommandRow =
  | { kind: "heading"; section: CommandSection }
  | { kind: "option"; option: CommandOption; section: CommandSection; /** 0-based among the options shown */ n: number };

export type FilteredRows = {
  rows: CommandRow[];
  /** Options shown */
  options: number;
  /** Options shown that a search found (forceShow ones left out): none is "No results" */
  counted: number;
  /** The row index of each option, by `n` */
  rowOf: number[];
  /** The section index (among the shown ones) of each option, by `n` */
  sectionOf: number[];
};

function score(option: CommandOption, query: string): number {
  const text = option.search.trim();
  if (!text) return 0;
  return defaultFilter(text, query, option.keywords?.map(k => k.trim()));
}

export function filterSections(sections: readonly CommandSection[], query: string): FilteredRows {
  const out: FilteredRows = { rows: [], options: 0, counted: 0, rowOf: [], sectionOf: [] };
  let shownSection = -1;
  for (const section of sections) {
    const kept = query
      ? section.options
          .map((option, i) => ({ option, i, s: score(option, query) }))
          .filter(x => x.option.forceShow || x.s > 0)
          .sort((a, b) => b.s - a.s || a.i - b.i)
          .map(x => x.option)
      : section.options;
    if (kept.length === 0) continue;
    shownSection++;
    if (section.heading) out.rows.push({ kind: "heading", section });
    for (const option of kept) {
      out.rowOf.push(out.rows.length);
      out.sectionOf.push(shownSection);
      out.rows.push({ kind: "option", option, section, n: out.options });
      out.options++;
      if (!option.forceShow) out.counted++;
    }
  }
  return out;
}

/** What a key does to the active option (VirtualCommand maps the keys, cmdk's set and PageUp/PageDown). */
export type Move = "next" | "prev" | "first" | "last" | "nextSection" | "prevSection" | "pageDown" | "pageUp";

/**
 * The active option after a move (`-1`: none). No wrap at either end. A section
 * jump lands on the first option of the next or previous section (as cmdk's
 * Alt+arrows, even going back), and moves by one where there is none.
 */
export function moveActive(active: number, move: Move, list: Pick<FilteredRows, "options" | "sectionOf">, pageSize = 8): number {
  const last = list.options - 1;
  if (last < 0) return -1;
  const clamp = (n: number) => Math.max(0, Math.min(last, n));
  switch (move) {
    case "next":
      return active < 0 ? 0 : clamp(active + 1);
    case "prev":
      return active < 0 ? -1 : clamp(active - 1);
    case "first":
      return 0;
    case "last":
      return last;
    case "pageDown":
      return clamp(Math.max(0, active) + pageSize);
    case "pageUp":
      return clamp(Math.max(0, active) - pageSize);
    case "nextSection": {
      const here = active < 0 ? -1 : list.sectionOf[active];
      const n = list.sectionOf.findIndex(s => s > here);
      return n >= 0 ? n : moveActive(active, "next", list, pageSize);
    }
    case "prevSection": {
      if (active < 0) return -1;
      const here = list.sectionOf[active];
      const target = here - 1;
      if (target < 0) return moveActive(active, "prev", list, pageSize);
      return list.sectionOf.indexOf(target);
    }
  }
}
