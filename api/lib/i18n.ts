import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import { isLocale, setLocaleSource, type Locale } from "@contracts/i18n";

/**
 * The language of the request being answered: the app sends its own
 * (x-locale), so error messages and texts made here match the screen.
 * Outside a request (background sync) the default applies.
 */
const requestLocale = new AsyncLocalStorage<Locale>();
setLocaleSource(() => requestLocale.getStore());

export const localeMiddleware: MiddlewareHandler = async (c, next) => {
  const asked = c.req.header("x-locale");
  if (!isLocale(asked)) return next();
  await requestLocale.run(asked, next);
};

/** Runs `fn` as if answering a request in `locale` (tests). */
export function withLocale<T>(locale: Locale, fn: () => T): T {
  return requestLocale.run(locale, fn);
}
