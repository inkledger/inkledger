// Dates in a notes search: `data:ieri`, `date:week`, `creata:7d`, `updated>2026-10-01`,
// `data:2026-10-01..2026-10-15`, beside the words searched. Read in the browser, where
// the user's days are: the server gets bounds, never words like "yesterday".
import { dateBounds, type QueryOp } from "./query";
import { dayKey } from "./time";

/** `noted`: the note's own day (day keys); `created` / `updated`: instants (ISO). */
export type NoteDateField = "noted" | "created" | "updated";
export type NoteDateFilter = { field: NoteDateField; from?: string; to?: string };
export type NoteQuery = { text: string; dates: NoteDateFilter[]; bad: string[] };

const NAMES: Record<string, NoteDateField> = {
  date: "noted", data: "noted", day: "noted", giorno: "noted",
  created: "created", creata: "created", creato: "created",
  updated: "updated", aggiornata: "updated", aggiornato: "updated",
};
// A whole term (not inside a word, not negated): name, operator, value.
const TERM = /(^|\s)(date|data|day|giorno|created|creata|creato|updated|aggiornata|aggiornato)(:|<=|>=|<|>)(\S+)/gi;

export function parseNoteQuery(input: string, now: Date): NoteQuery {
  const dates: NoteDateFilter[] = [];
  const bad: string[] = [];
  const text = input
    .replace(TERM, (whole, lead: string, name: string, rawOp: string, value: string) => {
      const field = NAMES[name.toLowerCase()];
      const op = (rawOp === ":" ? "=" : rawOp) as QueryOp;
      const span = dateBounds(op, value, now);
      if (!span) {
        bad.push(whole.trim());
        return lead;
      }
      const at = (d: Date | undefined) => (d ? (field === "noted" ? dayKey(d) : d.toISOString()) : undefined);
      dates.push({ field, from: at(span.from), to: at(span.to) });
      return lead;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text, dates, bad };
}

/** Quick date chips for the notes search: what each one adds to the query. */
export const NOTE_DATE_CHIPS = ["today", "yesterday", "week", "month"] as const;
