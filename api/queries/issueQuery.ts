// A search (contracts/query.ts) as conditions on the local catalogue. What
// the catalogue can't answer yet (clients, sprints, custom fields) is left
// out of the filter and reported, never silently dropped: a term the
// catalogue can't decide makes its whole OR (or NOT) undecidable too.
import { and, eq, inArray, not, notInArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { clientContainers, clients, connections, issues, worklogs } from "@db/schema";
import { dateBounds, formatQuery, priorityRankOfValue, type QueryExpr, type QueryField, type QueryTerm } from "@contracts/query";

export const CLOSED = ["done", "cancelled"];

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const contains = (col: AnyColumn, v: string) => sql`${col} ILIKE ${`%${escapeLike(v)}%`} ESCAPE '\\'`;
const equalsCi = (col: AnyColumn, v: string) => sql`${col} ILIKE ${escapeLike(v)} ESCAPE '\\'`;

/** Issues with activity since the user last looked. */
export const UNREAD_SQL = sql`(${issues.othersActivityAt} IS NOT NULL AND ${issues.othersActivityAt} > coalesce(${issues.seenAt}, 0))`;

/** The key a tracker's link points at (Jira browse, GitHub/GitLab/Gitea issues). */
export function keyOfLink(url: string): string | null {
  try {
    const u = new URL(url);
    const jira = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(u.pathname)?.[1] ?? u.searchParams.get("selectedIssue");
    if (jira) return jira.toUpperCase();
    const repo = /^\/(.+?)\/(?:-\/)?(?:issues|work_items)\/(\d+)\/?$/.exec(u.pathname);
    return repo ? `${repo[1]}#${repo[2]}` : null;
  } catch {
    return null;
  }
}

export type QueryContext = { myRemoteIds: string[]; now: Date };
export type CompiledQuery = { where: SQL | undefined; unsupported: string[] };

/** The query as one condition on `issues` (undefined: no condition). */
export function compileIssueQuery(expr: QueryExpr | null, ctx: QueryContext): CompiledQuery {
  const unsupported: string[] = [];
  const skip = (t: QueryTerm) => {
    unsupported.push(formatQuery(t, "en"));
    return null;
  };

  const term = (t: QueryTerm): SQL | null => {
    switch (t.kind) {
      case "text":
        return or(contains(issues.summary, t.text), contains(issues.key, t.text))!;
      case "ref": {
        const key = /^https?:/i.test(t.ref) ? keyOfLink(t.ref) : t.ref;
        const byKey = key ? (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) ? equalsCi(issues.key, key) : eq(issues.key, key)) : null;
        const byUrl = /^https?:/i.test(t.ref) ? eq(issues.url, t.ref) : null;
        return byKey && byUrl ? or(byKey, byUrl)! : (byKey ?? byUrl ?? sql`false`);
      }
      case "me":
        return ctx.myRemoteIds.length ? inArray(issues.assigneeId, ctx.myRemoteIds) : sql`false`;
      case "field":
        return field(t);
    }
  };

  const field = (t: Extract<QueryTerm, { kind: "field" }>): SQL | null => {
    const v = t.value;
    switch (t.field) {
      case "project":
        return or(equalsCi(issues.projectKey, v), contains(issues.projectName, v))!;
      case "client":
        // A client by its name or one of its other names; its containers are its issues.
        return sql`EXISTS (SELECT 1 FROM ${clientContainers} cc JOIN ${clients} cl ON cl.id = cc.client_id WHERE cc.container_id = ${issues.containerId} AND cl.user_id = ${issues.userId} AND (cl.name ILIKE ${escapeLike(v)} ESCAPE '\\' OR cl.aliases ILIKE ${`%${escapeLike(JSON.stringify(v))}%`} ESCAPE '\\'))`;
      case "source":
        return sql`EXISTS (SELECT 1 FROM ${connections} c WHERE c.id = ${issues.connectionId} AND (c.label ILIKE ${escapeLike(v)} ESCAPE '\\' OR c.type ILIKE ${escapeLike(v)} ESCAPE '\\' OR c.base_url ILIKE ${`%${escapeLike(v)}%`} ESCAPE '\\'))`;
      case "status":
        return equalsCi(issues.status, v);
      case "cat":
        return v === "closed" ? inArray(issues.category, CLOSED) : eq(issues.category, v);
      case "assignee":
        if (/^(me|io|@me|@io)$/i.test(v)) return term({ kind: "me" });
        return contains(issues.assigneeName, v);
      case "author":
        return contains(issues.reporterName, v);
      case "type":
        return equalsCi(issues.issueType, v);
      case "label":
        // labels is a JSON array: the quoted element, whatever its case.
        return contains(issues.labels, JSON.stringify(v));
      case "component":
        return contains(issues.components, JSON.stringify(v));
      case "priority": {
        const rank = priorityRankOfValue(v);
        if (rank === null) return equalsCi(issues.priority, v);
        const r = issues.priorityRank;
        // More important = a lower rank: "priority>=high" keeps highest and high.
        if (t.op === "=") return eq(r, rank);
        return t.op === ">" ? sql`${r} < ${rank}` : t.op === ">=" ? sql`${r} <= ${rank}` : t.op === "<" ? sql`${r} > ${rank}` : sql`${r} >= ${rank}`;
      }
      case "is":
        return v === "open"
          ? notInArray(issues.category, CLOSED)
          : v === "closed"
            ? inArray(issues.category, CLOSED)
            : v === "watched"
              ? eq(issues.watching, 1)
              : v === "favorite"
                ? eq(issues.favorite, 1)
                : v === "hidden"
                  ? eq(issues.hidden, 1)
                  : UNREAD_SQL;
      case "updated":
      case "created":
      case "due":
      case "logged":
        return dates(t);
      default:
        return skip(t);
    }
  };

  const dates = (t: Extract<QueryTerm, { kind: "field" }>): SQL | null => {
    const b = dateBounds(t.op, t.value, ctx.now);
    if (!b) return skip(t);
    if (t.field === "due") {
      const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return and(sql`${issues.dueDate} IS NOT NULL`, b.from ? sql`${issues.dueDate} >= ${day(b.from)}` : undefined, b.to ? sql`${issues.dueDate} < ${day(b.to)}` : undefined)!;
    }
    if (t.field === "logged") {
      return sql`EXISTS (SELECT 1 FROM ${worklogs} w WHERE w.user_id = ${issues.userId} AND w.connection_id = ${issues.connectionId} AND w.issue_key = ${issues.key}${b.from ? sql` AND w.started >= ${b.from.getTime()}` : sql``}${b.to ? sql` AND w.started < ${b.to.getTime()}` : sql``})`;
    }
    const col = t.field === "updated" ? issues.remoteUpdatedAt : issues.remoteCreatedAt;
    return and(sql`${col} IS NOT NULL`, b.from ? sql`${col} >= ${b.from.getTime()}` : undefined, b.to ? sql`${col} < ${b.to.getTime()}` : undefined)!;
  };

  const walk = (e: QueryExpr): SQL | null => {
    switch (e.kind) {
      case "and": {
        const parts = e.items.map(walk).filter((p): p is SQL => p !== null);
        return parts.length ? and(...parts)! : null;
      }
      case "or": {
        const parts = e.items.map(walk);
        return parts.every((p): p is SQL => p !== null) ? or(...parts)! : null;
      }
      case "not": {
        const inner = walk(e.item);
        // NULL-safe: a row without the value is "not" it.
        return inner ? not(sql`coalesce((${inner}), false)`) : null;
      }
      default:
        return term(e);
    }
  };

  return { where: expr ? (walk(expr) ?? undefined) : undefined, unsupported };
}

/** Whether a query decides by itself something a list view otherwise assumes (open only, mine only). */
export function mentions(expr: QueryExpr | null, fields: (QueryField | "me")[], values?: string[]): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "and":
    case "or":
      return expr.items.some((x) => mentions(x, fields, values));
    case "not":
      return mentions(expr.item, fields, values);
    case "me":
      return fields.includes("me");
    case "field":
      return fields.includes(expr.field) && (!values || values.includes(expr.value));
    default:
      return false;
  }
}
