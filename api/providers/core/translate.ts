// The search language (contracts/query.ts) in a tracker's own words: each
// adapter gives the words for the terms its search understands, this walks
// the query. A term it can't say is left out of what is sent and named in
// `unsupported` (the caller says so, never drops it silently); inside an OR
// or a NOT one unsayable term makes the whole group unsayable.
import { dateBounds, formatQuery, type QueryExpr, type QueryTerm } from "@contracts/query";

export type Translated = { query: string; unsupported: string[] };

export type Dialect = {
  /** One term in the tracker's words, or null when it can't say it */
  term(t: QueryTerm): string | null;
  and(parts: string[]): string;
  /** null: the tracker's search has no OR */
  or: ((parts: string[]) => string) | null;
  /** null: no NOT; given the term or group as said */
  not: ((part: string, item: QueryExpr) => string | null) | null;
};

export function translateWith(expr: QueryExpr | null, d: Dialect): Translated {
  const unsupported: string[] = [];
  const walk = (e: QueryExpr): string | null => {
    switch (e.kind) {
      case "and": {
        const parts = e.items.map(walk).filter((p): p is string => p !== null && p !== "");
        return parts.length ? d.and(parts) : null;
      }
      case "or": {
        const parts = e.items.map(walk);
        if (!d.or || parts.some((p) => p === null)) {
          unsupported.push(formatQuery(e, "en"));
          return null;
        }
        return d.or(parts as string[]);
      }
      case "not": {
        const inner = walk(e.item);
        const said = inner !== null && d.not ? d.not(inner, e.item) : null;
        if (said === null) unsupported.push(formatQuery(e, "en"));
        return said;
      }
      default: {
        const said = d.term(e);
        if (said === null) unsupported.push(formatQuery(e, "en"));
        return said;
      }
    }
  };
  return { query: expr ? (walk(expr) ?? "") : "", unsupported: [...new Set(unsupported)] };
}

/** A local day as YYYY-MM-DD. */
export const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A date term's bounds, as days (from inclusive, to exclusive), or null when the value isn't a date. */
export function dayBounds(t: Extract<QueryTerm, { kind: "field" }>, now: Date): { from?: string; to?: string } | null {
  const b = dateBounds(t.op, t.value, now);
  if (!b) return null;
  return { ...(b.from ? { from: dayOf(b.from) } : {}), ...(b.to ? { to: dayOf(b.to) } : {}) };
}
