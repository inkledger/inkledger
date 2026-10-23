import { addDays, dayKey, parseDayKey } from "./time";

/**
 * Quick capture of a TODO: the text as typed, with an optional day ("@…")
 * and an optional issue ("#…") taken out of it.
 *
 * Days: @oggi/@today, @domani/@tomorrow, @dopodomani, a weekday (@lun,
 * @lunedì, @mon, @monday: the next one, a week on when it is today's), a
 * date (@25/10 in Italian, @10/25 in English, with an optional year; a day
 * already past this year is next year's) or @2026-10-25.
 * Issues: #APP-12, #owner/repo#12, #group/sub/project#12.
 * The first of each counts; the rest stays in the text.
 */
export type ParsedTodo = { text: string; dueOn: string | null; issueKey: string | null; dayToken: string | null; issueToken: string | null };

const WEEKDAYS: Record<string, number> = {
  dom: 0, domenica: 0, sun: 0, sunday: 0,
  lun: 1, lunedi: 1, lunedì: 1, mon: 1, monday: 1,
  mar: 2, martedi: 2, martedì: 2, tue: 2, tuesday: 2,
  mer: 3, mercoledi: 3, mercoledì: 3, wed: 3, wednesday: 3,
  gio: 4, giovedi: 4, giovedì: 4, thu: 4, thursday: 4,
  ven: 5, venerdi: 5, venerdì: 5, fri: 5, friday: 5,
  sab: 6, sabato: 6, sat: 6, saturday: 6,
};
const RELATIVE: Record<string, number> = { oggi: 0, today: 0, domani: 1, tomorrow: 1, dopodomani: 2 };

/** The day a "@…" word names, from `today`; null when it names none. */
export function dayOfToken(word: string, today: Date, lang: "it" | "en"): string | null {
  const w = word.toLowerCase();
  if (w in RELATIVE) return dayKey(addDays(today, RELATIVE[w]));
  if (w in WEEKDAYS) {
    const ahead = (WEEKDAYS[w] - today.getDay() + 7) % 7 || 7;
    return dayKey(addDays(today, ahead));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return parseDayKey(w) ? w : null;
  const m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(w);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const [d, mo] = lang === "it" ? [a, b] : [b, a];
  const explicit = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
  const make = (y: number) => {
    const date = new Date(y, mo - 1, d);
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
  };
  if (explicit !== null) {
    const date = make(explicit);
    return date ? dayKey(date) : null;
  }
  // This year's, unless already past (or not a day this year, 29/2): then the next year's.
  const thisYear = make(today.getFullYear());
  if (thisYear && dayKey(thisYear) >= dayKey(today)) return dayKey(thisYear);
  const nextYear = make(today.getFullYear() + 1);
  return nextYear ? dayKey(nextYear) : null;
}

const ISSUE = /^#((?:[A-Za-z][A-Za-z0-9_]*-\d+)|(?:[\w.-]+(?:\/[\w.-]+)+#\d+))$/;

export function parseTodoInput(input: string, today: Date, lang: "it" | "en"): ParsedTodo {
  let dueOn: string | null = null;
  let issueKey: string | null = null;
  let dayToken: string | null = null;
  let issueToken: string | null = null;
  const kept: string[] = [];
  for (const word of input.trim().split(/\s+/)) {
    if (!word) continue;
    if (dueOn === null && word.startsWith("@") && word.length > 1) {
      const day = dayOfToken(word.slice(1), today, lang);
      if (day) {
        dueOn = day;
        dayToken = word;
        continue;
      }
    }
    if (issueKey === null) {
      const m = ISSUE.exec(word);
      if (m) {
        // A tracker key (APP-12) is upper case; a repository path keeps its own case.
        issueKey = m[1].includes("/") ? m[1] : m[1].toUpperCase();
        issueToken = word;
        continue;
      }
    }
    kept.push(word);
  }
  return { text: kept.join(" "), dueOn, issueKey, dayToken, issueToken };
}

/** How a TODO comes back once ticked: the next day, the next working day, a week on. */
export const TODO_REPEATS = ["daily", "weekdays", "weekly"] as const;
export type TodoRepeat = (typeof TODO_REPEATS)[number];

/** High first; normal is the default. */
export const TODO_PRIORITIES = [0, 1] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

/** A step inside a TODO: a small checklist, kept with it. */
export type TodoStep = { id: string; text: string; done: boolean };
export const MAX_TODO_STEPS = 20;
export const MAX_STEP_TEXT = 200;

/**
 * The day a repeating TODO comes back on, ticked on `today`: counted from its
 * own day or today, whichever is later, so a late one never comes back in the
 * past. Weekdays skip Saturday and Sunday.
 */
export function nextOccurrence(dueOn: string | null, today: string, repeat: TodoRepeat): string {
  const base = dueOn !== null && dueOn > today ? dueOn : today;
  const from = parseDayKey(base) ?? new Date();
  if (repeat === "weekly") return dayKey(addDays(from, 7));
  let next = addDays(from, 1);
  if (repeat === "weekdays") while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
  return dayKey(next);
}

/** Steps as stored (JSON text): what is not a valid list reads as none. */
export function parseSteps(raw: string | null | undefined): TodoStep[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((s: unknown) => {
      if (typeof s !== "object" || s === null) return [];
      const r = s as Record<string, unknown>;
      return typeof r.id === "string" && typeof r.text === "string" && typeof r.done === "boolean" ? [{ id: r.id, text: r.text, done: r.done }] : [];
    }).slice(0, MAX_TODO_STEPS);
  } catch {
    return [];
  }
}
