import { numberFormat, relativeFormat, t } from "@contracts/i18n";

/** "Mario Rossi" → "MR", "mario" → "MA". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2)
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3 days ago", "yesterday", "in 2 hours" relative to `now`. */
export function relativeTime(date: Date, now: number): string {
  const diff = (date.getTime() - now) / 1000;
  for (const [unit, secs] of STEPS) {
    if (Math.abs(diff) >= secs)
      return relativeFormat().format(Math.round(diff / secs), unit);
  }
  return t("ui.rel.now");
}

const size = () => numberFormat({ maximumFractionDigits: 1 });

/** 1536 → "1,5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${size().format(bytes / 1024)} KB`;
  return `${size().format(bytes / 1024 / 1024)} MB`;
}
