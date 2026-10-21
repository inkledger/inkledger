import { dateFormat, numberFormat } from "./i18n/core";

/**
 * Jira-style duration parsing/formatting shared by client and server.
 * Supports inputs like: "2h 30m", "1d", "1w 2d 3h 5m", "45m", "3" (hours),
 * Italian decimal commas ("1,5h", "1,5" → hours) and "2h30" (minutes after
 * hours, unit omitted).
 */

const UNIT_SECONDS: Record<string, number> = {
  w: 5 * 8 * 3600, // Jira convention: 1 week = 5 working days
  d: 8 * 3600, // 1 day = 8 working hours
  h: 3600,
  m: 60,
};

/** Longest single worklog accepted (one calendar day). */
export const MAX_WORKLOG_SECONDS = 24 * 3600;

/** A typed duration's day: the work schedule's day when the caller knows it (D14), else 8 hours. */
export type DurationOptions = { daySeconds?: number };

const unitSeconds = (unit: string, o: DurationOptions) => {
  const day = o.daySeconds && o.daySeconds > 0 ? o.daySeconds : UNIT_SECONDS.d;
  return unit === "d" ? day : unit === "w" ? 5 * day : UNIT_SECONDS[unit];
};

export function parseDurationToSeconds(input: string, o: DurationOptions = {}): number | null {
  const trimmed = input
    .trim()
    .toLowerCase()
    // Italian decimal comma: "1,5" → "1.5"
    .replace(/(\d),(\d)/g, "$1.$2")
    // "2h30" / "2h 30" → "2h30m": bare trailing number after hours is minutes
    .replace(/(\d\s*h\s*)(\d+)$/, "$1$2m");
  if (!trimmed) return null;

  // Plain number → hours
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(parseFloat(trimmed) * 3600);
  }

  const pattern = /(\d+(?:\.\d+)?)\s*([wdhm])/g;
  let total = 0;
  let matched = "";
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(trimmed)) !== null) {
    total += parseFloat(m[1]) * unitSeconds(m[2], o);
    matched += m[0];
  }
  // Reject if there is leftover unparsed content
  if (matched.replace(/\s+/g, "") !== trimmed.replace(/\s+/g, "")) {
    return null;
  }
  return Math.round(total);
}

/**
 * "1d 2h 30m". With `days: false`, hours and minutes only ("10h 30m"): what
 * a field shows to be read back, so a schedule's day never changes it.
 */
export function formatSeconds(totalSeconds: number, o: { days?: boolean } = {}): string {
  if (totalSeconds <= 0) return "0m";
  const parts: string[] = [];
  let rest = totalSeconds;
  for (const [unit, secs] of Object.entries(UNIT_SECONDS)) {
    if (o.days === false && (unit === "w" || unit === "d")) continue;
    const qty = Math.floor(rest / secs);
    if (qty > 0) {
      parts.push(`${qty}${unit}`);
      rest -= qty * secs;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "0m";
}

/** Hours with the locale's decimals, e.g. 5400 → "1.5h" ("1,5h" in Italian). */
export function formatHours(totalSeconds: number): string {
  return `${numberFormat({ maximumFractionDigits: 1 }).format(totalSeconds / 3600)}h`;
}

/** Long human duration, e.g. 27600 → "7 h 40 min", 2400 → "40 min". */
export function formatDurationLong(totalSeconds: number): string {
  const minutes = Math.round(Math.max(0, totalSeconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The one display format for durations: "2 h 21 min" below a day of work,
 * "2.556 h" for large totals, "—" for nothing.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 30) return "—";
  if (totalSeconds >= 24 * 3600) {
    return `${numberFormat({ maximumFractionDigits: 0 }).format(totalSeconds / 3600)} h`;
  }
  return formatDurationLong(totalSeconds);
}

/** The one display format for calendar dates: "5 Oct 2026" / "5 October 2026" ("5 ott 2026"). */
export function formatDate(date: Date | number, style: "short" | "long"): string {
  return dateFormat({ day: "numeric", month: style, year: "numeric" }).format(date);
}

/** Clock-style elapsed time, e.g. 5305 → "1:28:25". */
export function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Jira worklog "started" format: yyyy-MM-dd'T'HH:mm:ss.SSSZ (offset without colon) */
export function toJiraStarted(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

// ---------- Local calendar helpers (shared by client and server) ----------
// All of them work in the process/browser local time zone, the system's:
// the Docker container inherits the host zone (docker-compose.yml).

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local calendar day of `date` as "YYYY-MM-DD". */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse "YYYY-MM-DD" as local midnight; null when malformed. */
export function parseDayKey(key: string): Date | null {
  const m = DAY_KEY_RE.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKey(d) === key ? d : null;
}

/** Local midnight of `date`. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `date` shifted by whole calendar days (DST-safe). */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Local Monday 00:00 of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  return addDays(d, -((d.getDay() + 6) % 7));
}

/** Monday (local time) of the week containing `date`, as "YYYY-MM-DD". */
export function weekStartKey(date: Date): string {
  return dayKey(startOfWeek(date));
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInputValue(date: Date): string {
  return `${dayKey(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Away time worth asking about: the seconds between `lastSeen` and `now`
 * when they reach `thresholdMinutes` (0 disables), else 0.
 */
export function idleGap(lastSeen: number, now: number, thresholdMinutes: number): number {
  if (thresholdMinutes <= 0) return 0;
  const seconds = Math.floor((now - lastSeen) / 1000);
  return seconds >= thresholdMinutes * 60 ? seconds : 0;
}

export type TimeSpan = { start: Date; seconds: number };

/**
 * Free stretches of at least `minMinutes` inside [from, until], given the
 * logged spans of the day (overlaps allowed, any order).
 */
export function findGaps(
  spans: TimeSpan[],
  from: Date,
  until: Date,
  minMinutes = 30,
): TimeSpan[] {
  const min = minMinutes * 60_000;
  const gaps: TimeSpan[] = [];
  let cursor = from.getTime();
  const end = until.getTime();
  const sorted = [...spans].sort((a, b) => a.start.getTime() - b.start.getTime());
  const push = (a: number, b: number) => {
    if (b - a >= min) gaps.push({ start: new Date(a), seconds: Math.round((b - a) / 1000) });
  };
  for (const s of sorted) {
    const a = s.start.getTime();
    const b = a + s.seconds * 1000;
    if (a >= end) break;
    if (a > cursor) push(cursor, Math.min(a, end));
    cursor = Math.max(cursor, b);
  }
  if (cursor < end) push(cursor, end);
  return gaps;
}

/**
 * Wall-clock hours of `ms` since the local midnight `dayStart` (9:00 → 9),
 * also on DST days where the elapsed time is 8 or 10 hours.
 */
export function wallHours(ms: number, dayStart: number): number {
  const wall = (t: number) => t - new Date(t).getTimezoneOffset() * 60_000;
  return (wall(ms) - wall(dayStart)) / 3_600_000;
}
