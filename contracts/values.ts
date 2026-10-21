// Branded primitive values shared by server and app, so one can't be passed
// for another by mistake (an instant for a duration, a date string for a
// key). Each is a schema first: the type derives from it, and the same
// schema checks values coming from outside (a service, a request, JSON).
import { z } from "zod";

/** Epoch milliseconds, UTC (0 included). */
export const instantSchema = z.number().int().nonnegative().brand<"Instant">();
export type Instant = z.infer<typeof instantSchema>;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isCalendarDay = (text: string) => {
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

/** A calendar day, "YYYY-MM-DD", in a known time zone. */
export const localDateSchema = z.string().refine(isCalendarDay, "not a date (YYYY-MM-DD)").brand<"LocalDate">();
export type LocalDate = z.infer<typeof localDateSchema>;

const isTimeZone = (name: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

/** An IANA time zone ("Europe/Rome"). */
export const timeZoneSchema = z.string().min(1).refine(isTimeZone, "not a time zone").brand<"TimeZone">();
export type TimeZone = z.infer<typeof timeZoneSchema>;

/** Markdown (CommonMark). */
export const markdownSchema = z.string().brand<"Markdown">();
export type Markdown = z.infer<typeof markdownSchema>;

export class InvalidValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidValueError";
  }
}

const make =
  <S extends z.ZodType>(schema: S, what: string) =>
  (value: unknown): z.infer<S> => {
    const r = schema.safeParse(value);
    if (!r.success) throw new InvalidValueError(`Not ${what}: ${String(value)}`);
    return r.data;
  };

export const instant: (ms: number) => Instant = make(instantSchema, "an instant");
export const localDate: (text: string) => LocalDate = make(localDateSchema, "a date (YYYY-MM-DD)");
export const timeZone: (name: string) => TimeZone = make(timeZoneSchema, "a time zone");
export const markdown: (text: string) => Markdown = make(markdownSchema, "markdown");

/** An instant from a date-time text ("…Z", "…+02:00", Jira's "…+0200"), or null when missing or unreadable. */
export function instantFrom(text: string | null | undefined): Instant | null {
  if (!text) return null;
  const ms = Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(ms) && ms >= 0 ? instant(Math.trunc(ms)) : null;
}

/** The day an instant falls on, in a time zone. */
export function localDateOf(at: Instant, zone: TimeZone): LocalDate {
  return localDate(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at)));
}

/** A JSON value (what may be kept from a service's payload). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** A service payload kept as JSON, if it is JSON and not larger than `maxBytes` (else null). */
export function jsonPayload(value: unknown, maxBytes = 64 * 1024): JsonValue | null {
  try {
    const text = JSON.stringify(value);
    return text !== undefined && new TextEncoder().encode(text).length <= maxBytes ? (JSON.parse(text) as JsonValue) : null;
  } catch {
    return null;
  }
}

/** An array used as a set: no value twice (compared as JSON). */
export const uniqueArray = <S extends z.ZodType>(item: S) =>
  z.array(item).refine((xs) => new Set(xs.map((x) => JSON.stringify(x))).size === xs.length, "a value appears twice");
