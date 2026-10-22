// The search language as JQL: what Jira's search can say of each term.
import type { QueryTerm } from "@contracts/query";
import { dayBounds, translateWith, type Dialect, type Translated } from "../core/translate";
import type { QueryExpr } from "@contracts/query";

const quoted = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`;

/** Jira's own status categories, by id (the same on every site, any language). */
const CATEGORY_ID: Record<string, number> = { todo: 2, doing: 4, done: 3, closed: 3 };

function term(t: QueryTerm, now: Date): string | null {
  switch (t.kind) {
    case "text":
      return `text ~ ${quoted(t.text)}`;
    case "ref":
      return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t.ref) ? `key = ${t.ref.toUpperCase()}` : null;
    case "me":
      return "assignee = currentUser()";
    case "field": {
      const v = t.value;
      const me = /^(me|io|@me|@io)$/i.test(v);
      switch (t.field) {
        case "project":
          return `project = ${quoted(v)}`;
        case "status":
          return `status = ${quoted(v)}`;
        case "cat":
          return v in CATEGORY_ID ? `statusCategory = ${CATEGORY_ID[v]}` : null;
        case "assignee":
          return me ? "assignee = currentUser()" : null;
        case "author":
          return me ? "reporter = currentUser()" : null;
        case "type":
          return `issuetype = ${quoted(v)}`;
        case "label":
          return `labels = ${quoted(v)}`;
        case "component":
          return `component = ${quoted(v)}`;
        case "priority":
          return t.op === "=" ? `priority = ${quoted(v)}` : null;
        case "updated":
        case "created":
        case "due": {
          const b = dayBounds(t, now);
          if (!b) return null;
          const col = t.field === "due" ? "duedate" : t.field;
          const parts = [b.from ? `${col} >= "${b.from}"` : null, b.to ? `${col} < "${b.to}"` : null].filter(Boolean);
          return parts.length ? parts.join(" AND ") : null;
        }
        case "is":
          return v === "open" ? "statusCategory != 3" : v === "closed" ? "statusCategory = 3" : v === "watched" ? "watcher = currentUser()" : null;
        default:
          return null;
      }
    }
  }
}

export function toJql(expr: QueryExpr | null, now: Date): Translated {
  const d: Dialect = {
    term: (t) => term(t, now),
    and: (parts) => parts.map((p) => `(${p})`).join(" AND "),
    or: (parts) => parts.map((p) => `(${p})`).join(" OR "),
    not: (part) => `NOT (${part})`,
  };
  return translateWith(expr, d);
}
