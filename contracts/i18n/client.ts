// The page's i18n (swapped in for index.ts by vite.config.ts): English in the first
// load (less the settings' and the server's texts, fetched at start: englishReady), another
// language fetched when it is chosen (loadLocale, before it is used).
import type { Locale } from "./core";
import { hasDictionary, registerDictionary } from "./base";

export * from "./base";

// The rest of English (the settings' and the server's texts): fetched at once, never awaited
// by the first paint. What needs it (a page other than the first ones, a dialog) awaits it.
let english: Promise<void> | undefined;

/** Resolves once all of English is here (a failed fetch is tried again on the next call). */
export function englishReady(): Promise<void> {
  english ??= import("./en").then(
    m => registerDictionary("en", m.en),
    (e: unknown) => {
      english = undefined;
      throw e;
    },
  );
  return english;
}
if ("window" in globalThis) void englishReady().catch(() => undefined);

/** Fetches a language's texts once; until then its texts fall back to English. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (hasDictionary(locale)) return;
  if (locale === "it") registerDictionary("it", (await import("./it")).it);
}
