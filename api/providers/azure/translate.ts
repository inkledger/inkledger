// WIQL, the query language of Azure DevOps, as the adapter writes it: what
// the layer asks for (the user's items changed in a window, a text) turned
// into queries, with literals escaped. A query the user types goes to the
// service untouched (adapter.query); only these are built here.

import type { QueryExpr, QueryTerm } from "@contracts/query";
import { dayBounds, translateWith, type Dialect, type Translated } from "../core/translate";

/** A string literal: single-quoted, a quote inside doubled. */
export const wiqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A date-time literal: UTC with its Z (without it the service reads the profile's time zone). */
export const wiqlInstant = (ms: number) => `'${new Date(ms).toISOString()}'`;

/**
 * The user's items (assigned to @Me, any state, Removed included) changed
 * from `since` to `until`, oldest change first, ties by id: a stable order for
 * paging. Both bounds are inclusive; null leaves a side open.
 */
export function assignedChanged(since: number | null, until: number | null): string {
  const where = ["[System.AssignedTo] = @Me", ...(since === null ? [] : [`[System.ChangedDate] >= ${wiqlInstant(since)}`]), ...(until === null ? [] : [`[System.ChangedDate] <= ${wiqlInstant(until)}`])];
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] ASC, [System.Id] ASC`;
}

/** Every word in the title (any order), or the id when the text is a number; latest change first. */
export function titleSearch(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const byTitle = words.map((w) => `[System.Title] CONTAINS ${wiqlString(w)}`).join(" AND ") || "[System.Id] > 0";
  const id = /^#?(\d{1,10})$/.exec(text.trim());
  const where = id ? `[System.Id] = ${Number(id[1])} OR ${byTitle}` : byTitle;
  return `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`;
}

// ---------- The search language as WIQL (contract translate) ----------

const CATEGORY_STATES: Record<string, string> = { todo: "Proposed", doing: "InProgress", done: "Completed", closed: "Completed", cancelled: "Removed" };

function sayTerm(t: QueryTerm, now: Date): string | null {
  switch (t.kind) {
    case "text":
      return `[System.Title] CONTAINS ${wiqlString(t.text)}`;
    case "ref": {
      const id = /^(?:[^#]+#)?(\d{1,10})$/.exec(t.ref);
      return id ? `[System.Id] = ${Number(id[1])}` : null;
    }
    case "me":
      return "[System.AssignedTo] = @Me";
    case "field": {
      const v = t.value;
      const me = /^(me|io|@me|@io)$/i.test(v);
      switch (t.field) {
        case "project":
          return `[System.TeamProject] = ${wiqlString(v)}`;
        case "status":
          return `[System.State] = ${wiqlString(v)}`;
        case "cat":
          return v in CATEGORY_STATES ? `[System.State] IN GROUP ${wiqlString(CATEGORY_STATES[v])}` : null;
        case "assignee":
          return me ? "[System.AssignedTo] = @Me" : `[System.AssignedTo] = ${wiqlString(v)}`;
        case "author":
          return me ? "[System.CreatedBy] = @Me" : `[System.CreatedBy] = ${wiqlString(v)}`;
        case "type":
          return `[System.WorkItemType] = ${wiqlString(v)}`;
        case "label":
          return `[System.Tags] CONTAINS ${wiqlString(v)}`;
        case "updated":
        case "created": {
          const b = dayBounds(t, now);
          if (!b) return null;
          const col = t.field === "updated" ? "[System.ChangedDate]" : "[System.CreatedDate]";
          const parts = [b.from ? `${col} >= ${wiqlString(b.from)}` : null, b.to ? `${col} < ${wiqlString(b.to)}` : null].filter(Boolean);
          return parts.length ? parts.join(" AND ") : null;
        }
        case "is":
          return v === "open" ? "[System.State] NOT IN GROUP 'Completed' AND [System.State] NOT IN GROUP 'Removed'" : v === "closed" ? "[System.State] IN GROUP 'Completed'" : null;
        default:
          return null;
      }
    }
  }
}

/** The search language as a WIQL query of the user's work items; what it can't say is named. */
export function toWiql(expr: QueryExpr | null, now: Date): Translated {
  const d: Dialect = {
    term: (t) => sayTerm(t, now),
    and: (parts) => parts.map((p) => `(${p})`).join(" AND "),
    or: (parts) => parts.map((p) => `(${p})`).join(" OR "),
    not: (part) => `NOT (${part})`,
  };
  const said = translateWith(expr, d);
  return { query: said.query ? `SELECT [System.Id] FROM WorkItems WHERE ${said.query} ORDER BY [System.ChangedDate] DESC` : "", unsupported: said.unsupported };
}
