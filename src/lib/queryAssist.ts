import { queryFieldNames } from "@contracts/query";

/** The field names a word being typed may start, in the user's language first. */
export function fieldCompletions(value: string, lang: "en" | "it"): string[] {
  const word = /(?:^|\s)-?([^\s:()"]+)$/.exec(value)?.[1]?.toLowerCase() ?? "";
  if (!word) return [];
  const names = [...queryFieldNames(lang), ...queryFieldNames(lang === "it" ? "en" : "it")].map(f => f.name);
  return [...new Set(names)].filter(n => n.startsWith(word) && n !== word).slice(0, 6);
}

