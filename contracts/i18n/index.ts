import { currentLocale, lookup, pick, type Locale, type Path, type Tree, type Vars } from "./core";
import { en } from "./en";
import { it } from "./it";

export * from "./core";

export type Messages = typeof en;
export type MessageKey = Path<Messages>;

const DICTIONARIES: Record<Locale, Tree> = { en, it };

/** The text for `key` in the current locale, `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey, vars?: Vars): string {
  return tIn(currentLocale(), key, vars);
}

/** Same, in a given locale. A missing text falls back to English, then to the key. */
export function tIn(locale: Locale, key: MessageKey, vars?: Vars): string {
  const value = lookup(DICTIONARIES[locale], key) ?? lookup(en, key);
  return value === undefined ? key : pick(value, locale, vars);
}
