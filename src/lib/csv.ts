import { currentLocale, type Locale } from "@contracts/i18n";
import { downloadBlob } from "./download";

/**
 * CSV the way a spreadsheet in the user's language opens it: English uses
 * "," between cells and "." for decimals; Italian (Excel it-IT) ";" and ",".
 */
const DIALECT: Record<Locale, { separator: string; decimal: string }> = {
  en: { separator: ",", decimal: "." },
  it: { separator: ";", decimal: "," },
};

/** Plain number (no thousands grouping), the locale's decimal mark. */
export function csvNumber(value: number, locale: Locale = currentLocale()): string {
  const fixed = String(Math.round(value * 100) / 100);
  return fixed.replace(".", DIALECT[locale].decimal);
}

/**
 * One CSV cell. Text that a spreadsheet would read as a formula (= + - @, tab,
 * CR) gets a leading apostrophe: a comment like "- fix login" stays text and a
 * crafted Jira summary can't run as a formula.
 */
export function csvCell(value: string | number, locale: Locale = currentLocale()): string {
  const raw = typeof value === "number" ? csvNumber(value, locale) : value;
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  const special = new RegExp(`["${DIALECT[locale].separator}\\n\\r]`);
  return special.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Download rows as a BOM-prefixed CSV in the user's language dialect. */
export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number)[][]
): void {
  const locale = currentLocale();
  const body = [header, ...rows]
    .map(r => r.map(c => csvCell(c, locale)).join(DIALECT[locale].separator))
    .join("\r\n");
  downloadBlob(filename, new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" }));
}
