import { currentLocale, lookup, pick, type Locale, type Path, type Tree, type Vars } from "./core";
import type { en } from "./en";
import { enShell } from "./en/shell";

export * from "./core";

export type Messages = typeof en;
export type MessageKey = Path<Messages>;

// English is always here (the fallback): its first-load part at least, all of it once registered
// (index.ts at once, client.ts from its own chunk); other languages join the same way.
const DICTIONARIES: Partial<Record<Locale, Tree>> & { en: Tree } = { en: enShell };
let englishWhole = false;

export function registerDictionary(locale: Locale, tree: Tree): void {
  DICTIONARIES[locale] = tree;
  if (locale === "en") englishWhole = true;
}

export function hasDictionary(locale: Locale): boolean {
  return DICTIONARIES[locale] !== undefined;
}

/** The text for `key` in the current locale, `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey, vars?: Vars): string {
  return tIn(currentLocale(), key, vars);
}

/** Same, in a given locale. A missing text (or a language not loaded yet) falls back to English, then to the key. */
export function tIn(locale: Locale, key: MessageKey, vars?: Vars): string {
  const dict = DICTIONARIES[locale];
  const value = (dict ? lookup(dict, key) : undefined) ?? lookup(DICTIONARIES.en, key);
  // A text asked for before the rest of English arrived (a first-load gap, a bug): said, so the e2e catch it.
  if (value === undefined && !englishWhole) console.error(`[i18n] text asked for before its dictionary: ${key}`);
  return value === undefined ? key : pick(value, locale, vars);
}
