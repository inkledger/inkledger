// The search language as GitHub's issue-search qualifiers.
import type { QueryExpr, QueryTerm } from "@contracts/query";
import { dayBounds, translateWith, type Dialect, type Translated } from "../core/translate";

const quoted = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

function term(t: QueryTerm, now: Date): string | null {
  switch (t.kind) {
    case "text":
      return quoted(t.text);
    case "ref":
      // A key or link is found directly (findIssue), not searched.
      return null;
    case "me":
      return "assignee:@me";
    case "field": {
      const v = t.value;
      const me = /^(me|io|@me|@io)$/i.test(v);
      switch (t.field) {
        case "project":
          return v.includes("/") ? `repo:${v}` : `user:${v}`;
        case "status":
          return /^(open|closed)$/i.test(v) ? `state:${v.toLowerCase()}` : null;
        case "cat":
          return v === "done" || v === "closed" || v === "cancelled" ? "is:closed" : v === "todo" || v === "doing" ? "is:open" : null;
        case "assignee":
          return me ? "assignee:@me" : `assignee:${quoted(v)}`;
        case "author":
          return me ? "author:@me" : `author:${quoted(v)}`;
        case "label":
          return `label:${quoted(v)}`;
        case "updated":
        case "created": {
          const b = dayBounds(t, now);
          if (!b) return null;
          return b.from && b.to ? `${t.field}:${b.from}..${b.to}` : b.from ? `${t.field}:>=${b.from}` : b.to ? `${t.field}:<${b.to}` : null;
        }
        case "is":
          return v === "open" || v === "closed" ? `is:${v}` : null;
        default:
          return null;
      }
    }
  }
}

export function toGitHubQuery(expr: QueryExpr | null, now: Date): Translated {
  const d: Dialect = {
    term: (t) => term(t, now),
    and: (parts) => parts.join(" "),
    // GitHub's issue search has no OR across qualifiers.
    or: null,
    // Only a single qualifier or word can be negated.
    not: (part, item) => (item.kind === "field" || item.kind === "text" ? `-${part}` : null),
  };
  const said = translateWith(expr, d);
  // Without a repository or a person to search by, GitHub searches every public
  // issue: kept to the issues the user is involved in.
  return said.query && !SCOPED.test(said.query) ? { ...said, query: `${said.query} involves:@me` } : said;
}

/** A qualifier that already narrows the search: a repository, an owner or a person (not negated). */
const SCOPED = /(?:^|\s)(?:repo|user|org|assignee|author|involves|mentions|commenter):/;
