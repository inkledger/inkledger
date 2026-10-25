// Every language at once: the server and the tests. The page's build takes client.ts
// instead (vite.config.ts), which loads a language when it is chosen.
import type { Locale } from "./core";
import { hasDictionary, registerDictionary } from "./base";
import { it } from "./it";

export * from "./base";

registerDictionary("it", it);

/** Here every language is loaded already. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (!hasDictionary(locale)) throw new Error(`No dictionary for ${locale}`);
}
