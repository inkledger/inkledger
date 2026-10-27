import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { plainText, type RichDoc } from "@contracts/richtext";
import {
  NOTE_SEARCH_SNAPSHOT_MAX,
  type NoteFilter,
  type NoteSearchResult,
} from "@contracts/notes";
import { markdownNotes } from "@db/schema";
import { fromMarkdown } from "../providers/core/richtext";
import { getDb } from "./connection";
import { t } from "@contracts/i18n";

export function normalizeNoteSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .normalize("NFC");
}

export function noteDerived(
  title: string,
  body: string
): { bodyText: string; searchTitle: string; searchText: string; doc: RichDoc } {
  const doc = fromMarkdown(body, "gfm");
  const bodyText = plainText(doc);
  return {
    bodyText,
    searchTitle: normalizeNoteSearch(title).replace(/\s+/g, " ").trim(),
    searchText: normalizeNoteSearch(bodyText).replace(/\s+/g, " ").trim(),
    doc,
  };
}

export function noteSnippet(
  bodyText: string,
  query: string,
  max = 240
): string {
  const text = bodyText.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const terms = normalizeNoteSearch(query).split(/\s+/).filter(Boolean);
  const lower = text.toLocaleLowerCase();
  let at = terms.map(term => lower.indexOf(term)).find(i => i >= 0) ?? 0;
  if (at === 0 && normalizeNoteSearch(text).length !== text.length) {
    const folded = normalizeNoteSearch(text);
    at = terms.map(term => folded.indexOf(term)).find(i => i >= 0) ?? 0;
  }
  const start = Math.max(0, Math.min(at - 60, text.length - max));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + max).trim()}${start + max < text.length ? "…" : ""}`;
}

type SearchOptions = {
  query: string;
  filter: NoteFilter;
  issue?: { connectionId: number; issueKey: string };
  cursor?: string;
  limit: number;
};

const cursorSchema = z.object({
  v: z.literal(1),
  fingerprint: z.string().length(64),
  ids: z.array(z.uuid()).max(NOTE_SEARCH_SNAPSHOT_MAX),
  offset: z.number().int().nonnegative().max(NOTE_SEARCH_SNAPSHOT_MAX),
});
type Cursor = z.infer<typeof cursorSchema>;

function fingerprint(input: Omit<SearchOptions, "cursor" | "limit">): string {
  const value = JSON.stringify({
    q: normalizeNoteSearch(input.query),
    filter: input.filter,
    issue: input.issue ?? null,
  });
  return createHash("sha256").update(value).digest("hex");
}

export function encodeNoteCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeNoteCursor(
  raw: string,
  input: Omit<SearchOptions, "cursor" | "limit">
): Cursor {
  try {
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    );
    if (
      cursor.fingerprint !== fingerprint(input) ||
      cursor.offset > cursor.ids.length
    )
      throw new Error("stale cursor");
    return cursor;
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: t("server.notes.badCursor"),
    });
  }
}

const vector = sql`setweight(to_tsvector('simple', ${markdownNotes.searchTitle}), 'A') || setweight(to_tsvector('simple', ${markdownNotes.searchText}), 'B')`;

function searchWhere(
  userId: number,
  input: Omit<SearchOptions, "cursor" | "limit">,
  tsQuery: string
): SQL | undefined {
  return and(
    eq(markdownNotes.userId, userId),
    isNull(markdownNotes.deletedAt),
    sql`${vector} @@ to_tsquery('simple', ${tsQuery})`,
    input.filter === "free"
      ? isNull(markdownNotes.issueKey)
      : input.filter === "linked"
        ? sql`${markdownNotes.issueKey} IS NOT NULL`
        : undefined,
    input.issue
      ? and(
          eq(markdownNotes.connectionId, input.issue.connectionId),
          eq(markdownNotes.issueKey, input.issue.issueKey)
        )
      : undefined
  );
}

export async function searchNotes(
  userId: number,
  input: SearchOptions
): Promise<{ results: NoteSearchResult[]; nextCursor: string | null }> {
  const db = getDb();
  const base = { query: input.query, filter: input.filter, issue: input.issue };
  let ids: string[];
  let offset: number;
  if (input.cursor) {
    const cursor = decodeNoteCursor(input.cursor, base);
    ids = cursor.ids;
    offset = cursor.offset;
  } else {
    const lexemes = await db
      .select({ lexeme: sql<string>`lexeme` })
      .from(
        sql`unnest(to_tsvector('simple', ${normalizeNoteSearch(input.query)}))`
      );
    if (lexemes.length === 0) return { results: [], nextCursor: null };
    const tsQuery = lexemes
      .map(
        row => `'${row.lexeme.replace(/\\/g, "\\\\").replace(/'/g, "''")}':*`
      )
      .join(" & ");
    const rank = sql<number>`ts_rank(${vector}, to_tsquery('simple', ${tsQuery}))`;
    const first = await db
      .select({ id: markdownNotes.id })
      .from(markdownNotes)
      .where(searchWhere(userId, base, tsQuery))
      .orderBy(
        desc(rank),
        desc(markdownNotes.updatedAt),
        desc(markdownNotes.id)
      )
      .limit(NOTE_SEARCH_SNAPSHOT_MAX);
    ids = first.map(row => row.id);
    offset = 0;
  }
  const pageIds = ids.slice(offset, offset + input.limit);
  if (pageIds.length === 0) return { results: [], nextCursor: null };
  const rows = await db
    .select({
      id: markdownNotes.id,
      parentId: markdownNotes.parentId,
      title: markdownNotes.title,
      bodyText: markdownNotes.bodyText,
      connectionId: markdownNotes.connectionId,
      issueKey: markdownNotes.issueKey,
      updatedAt: markdownNotes.updatedAt,
    })
    .from(markdownNotes)
    .where(
      and(
        eq(markdownNotes.userId, userId),
        isNull(markdownNotes.deletedAt),
        inArray(markdownNotes.id, pageIds)
      )
    );
  const byId = new Map(rows.map(row => [row.id, row]));
  const visibleIds = pageIds.filter(id => byId.has(id));
  const active = visibleIds.length
    ? await db
        .select({
          id: markdownNotes.id,
          parentId: markdownNotes.parentId,
          title: markdownNotes.title,
        })
        .from(markdownNotes)
        .where(
          and(eq(markdownNotes.userId, userId), isNull(markdownNotes.deletedAt))
        )
    : [];
  const tree = new Map(active.map(row => [row.id, row]));
  const results = visibleIds.map(id => {
    const row = byId.get(id)!;
    const path: { id: string; title: string }[] = [];
    const seen = new Set([row.id]);
    let parentId = row.parentId;
    while (parentId && path.length < 32 && !seen.has(parentId)) {
      const parent = tree.get(parentId);
      if (!parent) break;
      path.unshift({ id: parent.id, title: parent.title });
      seen.add(parent.id);
      parentId = parent.parentId;
    }
    return {
      id: row.id,
      title: row.title,
      snippet: noteSnippet(row.bodyText, input.query),
      path,
      connectionId: row.connectionId,
      issueKey: row.issueKey,
      updatedAt: row.updatedAt,
    };
  });
  const nextOffset = offset + input.limit;
  return {
    results,
    nextCursor:
      nextOffset < ids.length
        ? encodeNoteCursor({
            v: 1,
            fingerprint: fingerprint(base),
            ids,
            offset: nextOffset,
          })
        : null,
  };
}
