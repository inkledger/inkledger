import type { StoreEntry } from "@contracts/store";
import { t, type useLocale } from "@/i18n";

export type Locale = ReturnType<typeof useLocale>;

/** A localized catalog text. */
export const loc = <T,>(v: { en: T; it: T }, locale: Locale): T => v[locale === "it" ? "it" : "en"];

export const nameOf = (e: StoreEntry, locale: Locale) => loc(e.name, locale);

export function formatPrice(e: StoreEntry, locale: Locale): string {
  if (!e.price) return "";
  return new Intl.NumberFormat(locale === "it" ? "it-IT" : "en-GB", { style: "currency", currency: e.price.currency }).format(e.price.amount);
}

/** What it costs, in words: the price, or free during the preview (and the price after it). */
export function priceLabel(e: StoreEntry, locale: Locale): string {
  if (e.mode === "paid") return formatPrice(e, locale);
  if (e.mode === "request") {
    return e.price
      ? `${t("settings.store.freePreview")} (${t("settings.store.priceAfter", { price: formatPrice(e, locale) })})`
      : t("settings.store.freePreview");
  }
  return t("settings.store.soon");
}
