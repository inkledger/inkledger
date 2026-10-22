/**
 * Translations shared by the app and the server. English is the default,
 * Italian the alternative; the dictionaries live in ./en and ./it, one file
 * per area, and the Italian one must have every English key (typecheck).
 *
 * Where the locale comes from depends on the side: the browser keeps the
 * user's choice, the server the one of the request being answered
 * (setLocaleSource). Never call t() at module level: the locale is read
 * when the text is made.
 */
export const LOCALES = ["en", "it"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", it: "Italiano" };
/** Intl tags: British English keeps the 24-hour clock and day-month order. */
export const INTL_TAG: Record<Locale, string> = { en: "en-GB", it: "it-IT" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A text that depends on a count: `{count}` inside is replaced too. */
export type Plural = { one: string; other: string };
export type Tree = { [key: string]: string | Plural | Tree };

/** Same keys as `T`, any text: what a translation has to provide. */
export type Shape<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : Shape<T[K]>;
};

/** "a.b.c" paths to every text of `T`. */
export type Path<T> = {
  [K in keyof T & string]: T[K] extends string | Plural ? K : `${K}.${Path<T[K]>}`;
}[keyof T & string];

let source: () => Locale | undefined = () => undefined;
const fallback: Locale = DEFAULT_LOCALE;

/** Where the current locale comes from (the browser store, the server request). */
export function setLocaleSource(fn: () => Locale | undefined): void {
  source = fn;
}

export function currentLocale(): Locale {
  return source() ?? fallback;
}

export type Vars = Record<string, string | number>;

export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

export function pick(value: string | Plural, locale: Locale, vars?: Vars): string {
  if (typeof value === "string") return interpolate(value, vars);
  const count = Number(vars?.count ?? 0);
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(INTL_TAG[locale])));
  return interpolate(rules.select(count) === "one" ? value.one : value.other, vars);
}

export function lookup(tree: Tree, path: string): string | Plural | undefined {
  let node: string | Plural | Tree | undefined = tree;
  for (const part of path.split(".")) {
    if (!node || typeof node === "string") return undefined;
    node = (node as Tree)[part];
  }
  return typeof node === "string" || (node && "other" in node && typeof node.other === "string")
    ? (node as string | Plural)
    : undefined;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

/** A date formatter in the current locale (cached per locale and options). */
export function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = currentLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = dateFormats.get(key);
  if (!f) dateFormats.set(key, (f = new Intl.DateTimeFormat(INTL_TAG[locale], options)));
  return f;
}

/** A number formatter in the current locale (cached per locale and options). */
export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const locale = currentLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (!f) numberFormats.set(key, (f = new Intl.NumberFormat(INTL_TAG[locale], options)));
  return f;
}

/** Relative times ("2 minutes ago") in the current locale. */
export function relativeFormat(): Intl.RelativeTimeFormat {
  return new Intl.RelativeTimeFormat(INTL_TAG[currentLocale()], { numeric: "auto" });
}
