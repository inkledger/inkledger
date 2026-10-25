import { currentLocale, lookup, pick, type Locale, type Path, type Tree, type Vars } from "./core";
import { en } from "./en";

export * from "./core";

export type Messages = typeof en;
export type MessageKey = Path<Messages>;

// English is always here (the fallback); other languages join (index.ts at once, client.ts on demand).
const DICTIONARIES: Partial<Record<Locale, Tree>> = { en };

export function registerDictionary(locale: Locale, tree: Tree): void {
  DICTIONARIES[locale] = tree;
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
  const value = (dict ? lookup(dict, key) : undefined) ?? lookup(en, key);
  return value === undefined ? key : pick(value, locale, vars);
}
