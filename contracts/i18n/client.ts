// The page's i18n (swapped in for index.ts by vite.config.ts): English in the first
// load, another language fetched when it is chosen (loadLocale, before it is used).
import type { Locale } from "./core";
import { hasDictionary, registerDictionary } from "./base";

export * from "./base";

/** Fetches a language's texts once; until then its texts fall back to English. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (hasDictionary(locale)) return;
  if (locale === "it") registerDictionary("it", (await import("./it")).it);
}
