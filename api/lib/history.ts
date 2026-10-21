import { t, type MessageKey } from "@contracts/i18n";
import { parseJiraDate, textFromAdf, type JiraComment, type JiraHistory } from "../jira/client";

/** Field names as Jira reports them (English or localized) → dictionary key. */
const FIELD_KEYS: Record<string, MessageKey> = {
  status: "server.history.fields.status",
  assignee: "server.history.fields.assignee",
  priority: "server.history.fields.priority",
  duedate: "server.history.fields.duedate",
  timeestimate: "server.history.fields.timeestimate",
  timeoriginalestimate: "server.history.fields.timeoriginalestimate",
  timespent: "server.history.fields.timespent",
  worklogid: "server.history.fields.worklogid",
  sprint: "server.history.fields.sprint",
  description: "server.history.fields.description",
  summary: "server.history.fields.summary",
  labels: "server.history.fields.labels",
  resolution: "server.history.fields.resolution",
  attachment: "server.history.fields.attachment",
  link: "server.history.fields.link",
  "epic link": "server.history.fields.epic",
  "epic child": "server.history.fields.epic",
  parent: "server.history.fields.parent",
  "fix version": "server.history.fields.version",
  version: "server.history.fields.version",
  component: "server.history.fields.component",
  reporter: "server.history.fields.reporter",
  rank: "server.history.fields.rank",
  workflow: "server.history.fields.workflow",
  comment: "server.history.fields.comment",
};

export function fieldLabel(field: string): string {
  const key = FIELD_KEYS[field.toLowerCase()];
  return key ? t(key) : field;
}

/** Long values (descriptions) are cut: the timeline is a summary. */
function short(v: string | null | undefined, max = 140): string | null {
  if (v == null) return null;
  const text = v.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type HistoryEvent =
  | {
      kind: "change";
      at: number;
      author: string | null;
      items: { field: string; from: string | null; to: string | null }[];
    }
  | { kind: "comment"; at: number; author: string | null; excerpt: string }
  | { kind: "created"; at: number; author: string | null };

/** One line saying why the issue moved last (newest event). */
export function reasonOf(e: HistoryEvent | undefined): string | null {
  if (!e) return null;
  const by = e.author ? t("server.history.by", { author: e.author }) : "";
  if (e.kind === "created") return t("server.history.created", { by });
  if (e.kind === "comment") return t("server.history.comment", { by });
  const first = e.items[0];
  if (!first) return t("server.history.modified", { by });
  const what =
    first.from || first.to
      ? `${first.field}: ${first.from ?? "—"} → ${first.to ?? "—"}`
      : first.field;
  const more = e.items.length > 1 ? ` (+${e.items.length - 1})` : "";
  return `${what}${more}${by}`;
}

/** Changes, comments and creation as one timeline, newest first. */
export function buildTimeline(raw: {
  created: string | null;
  reporter: string | null;
  histories: JiraHistory[];
  comments: JiraComment[];
}): { events: HistoryEvent[]; reason: string | null } {
  const events: HistoryEvent[] = [];
  for (const h of raw.histories) {
    const at = parseJiraDate(h.created);
    if (at === null) continue;
    const items = (h.items ?? [])
      .filter((i) => i.field)
      .map((i) => {
        const field = fieldLabel(i.field!);
        const long = FIELD_KEYS[i.field!.toLowerCase()] === "server.history.fields.description";
        return {
          field,
          // A description diff is unreadable here: say it changed.
          from: long ? null : short(i.fromString),
          to: long ? (i.toString ? t("server.history.updated") : null) : short(i.toString),
        };
      });
    if (items.length === 0) continue;
    events.push({
      kind: "change",
      at,
      author: h.author?.displayName ?? h.author?.name ?? null,
      items,
    });
  }
  for (const c of raw.comments) {
    const at = parseJiraDate(c.created);
    if (at === null) continue;
    const text = typeof c.body === "string" ? c.body : textFromAdf(c.body);
    events.push({
      kind: "comment",
      at,
      author: c.author?.displayName ?? c.author?.name ?? null,
      excerpt: short(text, 200) ?? "",
    });
  }
  const createdAt = parseJiraDate(raw.created);
  if (createdAt !== null) events.push({ kind: "created", at: createdAt, author: raw.reporter });
  events.sort((a, b) => b.at - a.at);
  return { events, reason: reasonOf(events[0]) };
}
