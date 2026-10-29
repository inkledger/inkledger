// YouTrack's query language, as far as inkledger writes it. Pure: no I/O.
// Traps: dates in a query are read in the requesting user's time zone (not
// UTC), and at day precision; a free-text search with braces or quotes left in
// it is a syntax error (400) or a different query.
import type { QueryExpr, QueryTerm } from "@contracts/query";
import { DAY_MS } from "@contracts/time";
import { dayBounds, translateWith, type Dialect, type Translated } from "../core/translate";
import { ProviderError } from "../core/errors";

/** The widest offset of a time zone from UTC, plus a day: a query date this far back covers the user's midnight wherever they live. */
export const QUERY_DATE_MARGIN_MS = 36 * 3_600_000;

/** A date as a query writes it (yyyy-MM-dd), from an instant. */
export const queryDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * "Mine, changed since" for a pass. The start date is moved back by
 * QUERY_DATE_MARGIN_MS so that, read in any time zone, it starts before
 * `sinceMs`: the exact cut is made on the issues' `updated` timestamps.
 */
export function assignedQuery(sinceMs: number | null): string {
  const changed = sinceMs === null ? "" : ` updated: ${queryDate(sinceMs - QUERY_DATE_MARGIN_MS)} .. *`;
  return `for: me${changed} sort by: updated asc`;
}

/** Free text as a search term: braces mark a phrase, so none is left inside it. Empty for nothing searchable. */
export function textQuery(text: string): string {
  const words = text
    // eslint-disable-next-line no-control-regex
    .replace(/[{}"\\\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words ? `{${words}}` : "";
}

/** A query someone wrote in YouTrack's language, checked for what the service would refuse anyway (cheaper to say here). */
export function checkQuery(query: string): string {
  const q = query.trim();
  if (!q) throw new ProviderError("invalid", "YouTrack: an empty query");
  if (q.length > 2000) throw new ProviderError("invalid", "YouTrack: a query longer than 2000 characters");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(q)) throw new ProviderError("invalid", "YouTrack: control characters in a query");
  if ((q.match(/\{/g) ?? []).length !== (q.match(/\}/g) ?? []).length) throw new ProviderError("invalid", "YouTrack: unbalanced braces in a query");
  if ((q.match(/"/g) ?? []).length % 2 !== 0) throw new ProviderError("invalid", "YouTrack: an unclosed quote in a query");
  return q;
}

export { DAY_MS };

// ---------- The search language as a YouTrack query (contract translate) ----------

/** A value as YouTrack takes it: braces around anything with spaces. */
const yt = (v: string) => (/[\s,:{}]/.test(v) ? `{${v.replace(/[{}]/g, "")}}` : v);

function sayTerm(t: QueryTerm, now: Date): string | null {
  switch (t.kind) {
    case "text":
      return /\s/.test(t.text) ? `"${t.text.replace(/"/g, "")}"` : t.text;
    case "ref":
      return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t.ref) ? `issue id: ${t.ref}` : null;
    case "me":
      return "for: me";
    case "field": {
      const v = t.value;
      const me = /^(me|io|@me|@io)$/i.test(v);
      switch (t.field) {
        case "project":
          return `project: ${yt(v)}`;
        case "status":
          return `State: ${yt(v)}`;
        case "cat":
          return v === "done" || v === "cancelled" || v === "closed" ? "#Resolved" : v === "todo" || v === "doing" ? "#Unresolved" : null;
        case "assignee":
          return me ? "for: me" : `for: ${yt(v)}`;
        case "author":
          return me ? "reporter: me" : `reporter: ${yt(v)}`;
        case "type":
          return `Type: ${yt(v)}`;
        case "label":
          return `tag: ${yt(v)}`;
        case "priority":
          return t.op === "=" ? `Priority: ${yt(v)}` : null;
        case "updated":
        case "created": {
          const b = dayBounds(t, now);
          if (!b) return null;
          // Inclusive day ranges; "*" for an open end.
          const last = b.to ? queryDate(Date.parse(`${b.to}T00:00:00Z`) - DAY_MS) : "*";
          return `${t.field}: ${b.from ?? "*"} .. ${last}`;
        }
        case "is":
          return v === "open" ? "#Unresolved" : v === "closed" ? "#Resolved" : v === "watched" ? "has: star" : null;
        default:
          return null;
      }
    }
  }
}

/** The search language in YouTrack's own query words; what it can't say is named. */
export function toYouTrackQuery(expr: QueryExpr | null, now: Date): Translated {
  const d: Dialect = {
    term: (t) => sayTerm(t, now),
    and: (parts) => parts.join(" "),
    or: (parts) => parts.map((p) => `(${p})`).join(" or "),
    // Only a single tag or value can be left out (tag: -x): groups can't.
    not: (part, item) => (item.kind === "field" && /^(tag|State|Type|Priority|project): /.test(part) ? part.replace(/: /, ": -") : null),
  };
  return translateWith(expr, d);
}
