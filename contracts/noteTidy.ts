// "Tidy up with AI" on a note: the model rewrites the text formally, with clean
// Markdown, and must keep every fact. What it dropped is said beside its copy.

/** Up to this much text goes to a local model (it writes the whole note back, inside JSON). */
export const TIDY_MAX = 10_000;

const LANGUAGE: Record<string, string> = { en: "English", it: "Italian" };

export function tidyInstructions(locale: string): string {
  return [
    "You tidy up a person's working note.",
    "Rewrite it in a clear, formal style, in the note's own language, and fix its Markdown: headings, lists, tables and code blocks where they fit.",
    "Keep every fact: do not add information, do not remove any, do not change names, numbers, dates, issue keys (like APP-12), links or image references (like ![x](idea-file:3)).",
    `If the language of the note is unclear, write in ${LANGUAGE[locale] ?? "English"}.`,
  ].join(" ");
}

/** Issue keys, links and numbers of `original` that `result` lost (each once). */
export function tidyMissing(original: string, result: string): string[] {
  const found = (re: RegExp, text: string) => [...new Set(text.match(re) ?? [])];
  const keys = found(/\b[A-Z][A-Z0-9]+-\d+\b/g, original);
  const links = found(/https?:\/\/[^\s)>\]]+/g, original);
  const numbers = found(/\d+(?:[.,:]\d+)*/g, original.replace(/https?:\/\/[^\s)>\]]+/g, " ").replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " "));
  return [...keys, ...links, ...numbers].filter(x => !result.includes(x));
}
