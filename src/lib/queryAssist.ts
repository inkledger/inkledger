import { formatQuery, parseQuery, queryFieldNames, type QueryExpr, type QueryTerm } from "@contracts/query";

/** The field names a word being typed may start, in the user's language first. */
export function fieldCompletions(value: string, lang: "en" | "it"): string[] {
  const word = /(?:^|\s)-?([^\s:()"]+)$/.exec(value)?.[1]?.toLowerCase() ?? "";
  if (!word) return [];
  const names = [...queryFieldNames(lang), ...queryFieldNames(lang === "it" ? "en" : "it")].map(f => f.name);
  return [...new Set(names)].filter(n => n.startsWith(word) && n !== word).slice(0, 6);
}

const same = (a: QueryExpr, b: QueryTerm) => formatQuery(a, "en") === formatQuery(b, "en");
/** The query's parts joined by AND (one part when there is no AND at the top). */
const partsOf = (expr: QueryExpr | null): QueryExpr[] => (!expr ? [] : expr.kind === "and" ? expr.items : [expr]);

/** Whether `term` is one of the query's AND-ed parts (a quick filter shown on). */
export function hasPreset(value: string, term: QueryTerm): boolean {
  return partsOf(parseQuery(value).expr).some(p => same(p, term));
}

/** The query with `term` switched on or off, written back in `lang`. */
export function togglePreset(value: string, term: QueryTerm, lang: "en" | "it"): string {
  const parsed = parseQuery(value);
  const parts = partsOf(parsed.expr);
  const next = parts.some(p => same(p, term)) ? parts.filter(p => !same(p, term)) : [...parts, term];
  // What the parser could not read stays as typed: a tap never deletes it.
  const kept = parsed.warnings.filter(w => w.dropped).map(w => {
    const word = /\s/.test(w.at) ? `"${w.at}"` : w.at;
    return value.includes(`-${word}`) || value.includes(`!${word}`) ? `-${word}` : word;
  });
  const written = [next.length === 0 ? "" : formatQuery(next.length === 1 ? next[0] : { kind: "and", items: next }, lang), ...kept].filter(Boolean).join(" ");
  return written ? written + " " : "";
}
