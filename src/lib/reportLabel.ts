import { addDays, dayKey, parseDayKey, startOfWeek } from "@contracts/time";
import { dateFormat, t } from "@contracts/i18n";

export type ReportRow = {
  key: string;
  label: string;
  seconds: number;
  entries: number;
  /** An issue row: its identity (two trackers may share a key), link, tracker and container */
  id?: string;
  connectionId?: number | null;
  remoteId?: string | null;
  tracker?: string;
  container?: string;
};

export type GroupBy = "day" | "issue" | "project" | "client";

const dayFormat = () =>
  dateFormat({
    weekday: "short",
    day: "numeric",
    month: "short",
  });

export function rowLabel(groupBy: GroupBy, row: ReportRow): string {
  if (groupBy === "day") {
    const d = parseDayKey(row.key);
    return d ? dayFormat().format(d).replace(/\./g, "") : row.key;
  }
  return row.label;
}

/** Splits "KEY — summary" / "PRJ — name" into its two parts. */
export function splitLabel(label: string): { head: string; tail?: string } {
  const i = label.indexOf(" — ");
  return i < 0
    ? { head: label }
    : { head: label.slice(0, i), tail: label.slice(i + 3) };
}

export type PresetId = "week" | "lastWeek" | "month" | "lastMonth";

/** Labels are read when asked (getters): they follow the language. */
export const PRESET_OPTIONS: { value: PresetId; label: string }[] = [
  {
    value: "week",
    get label() {
      return t("ui.preset.week");
    },
  },
  {
    value: "lastWeek",
    get label() {
      return t("ui.preset.lastWeek");
    },
  },
  {
    value: "month",
    get label() {
      return t("ui.preset.month");
    },
  },
  {
    value: "lastMonth",
    get label() {
      return t("ui.preset.lastMonth");
    },
  },
];

/** Date range (inclusive) of a preset, relative to `now`. */
export function presetRange(id: PresetId, now: Date): { from: Date; to: Date } {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (id) {
    case "week": {
      const start = startOfWeek(now);
      return { from: start, to: addDays(start, 6) };
    }
    case "lastWeek": {
      const start = addDays(startOfWeek(now), -7);
      return { from: start, to: addDays(start, 6) };
    }
    case "month":
      return { from: new Date(y, m, 1), to: new Date(y, m + 1, 0) };
    case "lastMonth":
      return { from: new Date(y, m - 1, 1), to: new Date(y, m, 0) };
  }
}

/** The preset matching exactly this day-key range, if any. */
export function activePreset(
  from: string,
  to: string,
  now: Date
): PresetId | null {
  for (const { value } of PRESET_OPTIONS) {
    const r = presetRange(value, now);
    if (dayKey(r.from) === from && dayKey(r.to) === to) return value;
  }
  return null;
}
