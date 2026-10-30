import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  NOTE_MAX_DEPTH,
  NOTE_MAX_SUBTREE,
  NOTE_TRASH_DAYS,
  NOTE_VERSION_DAYS,
  NOTE_VERSION_MAX,
  type NoteConflict,
  type NoteDocument,
  noteKind,
  type NoteKind,
  type NoteTreeItem,
  type NoteUpdated,
  type NoteVersionOrigin,
} from "@contracts/notes";
import {
  markdownNoteVersions,
  markdownNotes,
  type MarkdownNote,
} from "@db/schema";
import { getDb, type Db } from "./connection";
import { noteDerived } from "./noteSearch";
import { t } from "@contracts/i18n";
import { dayKey } from "@contracts/time";

export type NoteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Store = Db | NoteTx;

const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: t("server.notes.notFound") });

const folderInNote = () =>
  new TRPCError({ code: "CONFLICT", message: t("server.notes.folderInNote") });

export function noteTreeItem(row: MarkdownNote): NoteTreeItem {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: noteKind(row.kind),
    hasText: row.body.trim() !== "",
    position: row.position,
    title: row.title,
    contentRevision: row.contentRevision,
    connectionId: row.connectionId,
    issueKey: row.issueKey,
    notedOn: row.notedOn,
    hasAi: row.aiBody !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function noteDocument(row: MarkdownNote): NoteDocument {
  return {
    ...noteTreeItem(row),
    body: row.body,
    doc: noteDerived(row.title, row.body).doc,
    ai:
      row.aiBody === null
        ? null
        : {
            body: row.aiBody,
            doc: noteDerived(row.title, row.aiBody).doc,
            createdAt: row.aiCreatedAt,
            stale: row.aiSourceRevision !== row.contentRevision,
          },
  };
}

export async function ownNote(
  db: Store,
  userId: number,
  id: string,
  active = false
): Promise<MarkdownNote> {
  const [row] = await db
    .select()
    .from(markdownNotes)
    .where(
      and(
        eq(markdownNotes.id, id),
        eq(markdownNotes.userId, userId),
        active ? isNull(markdownNotes.deletedAt) : undefined
      )
    );
  if (!row) throw notFound();
  return row;
}

export async function lockNoteTree(tx: NoteTx, userId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('markdown-notes-tree'), ${userId})`
  );
}

async function activeParent(
  tx: NoteTx,
  userId: number,
  parentId: string | null
): Promise<MarkdownNote | null> {
  return parentId ? ownNote(tx, userId, parentId, true) : null;
}

type Ancestor = { id: string; parent_id: string | null; depth: number };

async function ancestors(
  tx: NoteTx,
  userId: number,
  id: string
): Promise<Ancestor[]> {
  const result = (await tx.execute(sql`
    WITH RECURSIVE ancestors(id, parent_id, depth, path) AS (
      SELECT n.id, n.parent_id, 0, ARRAY[n.id]::uuid[]
      FROM markdown_notes n
      WHERE n.id = ${id} AND n.user_id = ${userId}
      UNION ALL
      SELECT n.id, n.parent_id, a.depth + 1, a.path || n.id
      FROM markdown_notes n
      JOIN ancestors a ON n.id = a.parent_id
      WHERE n.user_id = ${userId} AND NOT n.id = ANY(a.path) AND a.depth < ${NOTE_MAX_DEPTH + 1}
    )
    SELECT id, parent_id, depth FROM ancestors
  `)) as { rows: Ancestor[] };
  return result.rows;
}

type SubtreeNode = { id: string; depth: number };

export async function noteSubtree(
  tx: NoteTx,
  userId: number,
  rootId: string
): Promise<SubtreeNode[]> {
  const result = (await tx.execute(sql`
    WITH RECURSIVE subtree(id, depth, path) AS (
      SELECT n.id, 0, ARRAY[n.id]::uuid[]
      FROM markdown_notes n
      WHERE n.id = ${rootId} AND n.user_id = ${userId} AND n.deleted_at IS NULL
      UNION ALL
      SELECT n.id, s.depth + 1, s.path || n.id
      FROM markdown_notes n
      JOIN subtree s ON n.parent_id = s.id
      WHERE n.user_id = ${userId} AND n.deleted_at IS NULL AND NOT n.id = ANY(s.path) AND s.depth < ${NOTE_MAX_DEPTH + 1}
    )
    SELECT id, depth FROM subtree LIMIT ${NOTE_MAX_SUBTREE + 1}
  `)) as { rows: SubtreeNode[] };
  const rows = result.rows;
  if (rows.length > NOTE_MAX_SUBTREE)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: t("server.notes.tooLarge", { count: NOTE_MAX_SUBTREE }),
    });
  return rows;
}

async function checkPlacement(
  tx: NoteTx,
  userId: number,
  parent: MarkdownNote | null,
  subtree: SubtreeNode[]
): Promise<void> {
  if (!parent) return;
  const parents = await ancestors(tx, userId, parent.id);
  const parentDepth = Math.max(...parents.map(row => Number(row.depth)));
  const subtreeDepth = Math.max(0, ...subtree.map(row => Number(row.depth)));
  if (parentDepth + subtreeDepth + 1 > NOTE_MAX_DEPTH) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: t("server.notes.tooDeep", { count: NOTE_MAX_DEPTH }),
    });
  }
}

async function normalizeSiblings(
  tx: NoteTx,
  userId: number,
  parentId: string | null,
  orderedIds?: string[]
): Promise<void> {
  const rows = await tx
    .select({ id: markdownNotes.id, kind: markdownNotes.kind })
    .from(markdownNotes)
    .where(
      and(
        eq(markdownNotes.userId, userId),
        isNull(markdownNotes.deletedAt),
        parentId
          ? eq(markdownNotes.parentId, parentId)
          : isNull(markdownNotes.parentId)
      )
    )
    .orderBy(asc(markdownNotes.position), asc(markdownNotes.id));
  const current = rows.map(row => row.id);
  const asked = orderedIds
    ? [...orderedIds, ...current.filter(id => !orderedIds.includes(id))]
    : current;
  // Folders first, then notes, each in the order asked: a move never mixes them.
  const folders = new Set(rows.filter(row => row.kind === "folder").map(row => row.id));
  const wanted = [...asked.filter(id => folders.has(id)), ...asked.filter(id => !folders.has(id))];
  for (const [position, id] of wanted.entries()) {
    await tx
      .update(markdownNotes)
      .set({ position })
      .where(and(eq(markdownNotes.id, id), eq(markdownNotes.userId, userId)));
  }
}

export async function pruneNoteVersions(
  tx: NoteTx,
  userId: number,
  noteId: string,
  now = new Date()
): Promise<void> {
  await tx
    .delete(markdownNoteVersions)
    .where(
      and(
        eq(markdownNoteVersions.userId, userId),
        eq(markdownNoteVersions.noteId, noteId),
        lt(
          markdownNoteVersions.createdAt,
          new Date(now.getTime() - NOTE_VERSION_DAYS * 86_400_000)
        )
      )
    );
  const versions = await tx
    .select({ id: markdownNoteVersions.id })
    .from(markdownNoteVersions)
    .where(
      and(
        eq(markdownNoteVersions.userId, userId),
        eq(markdownNoteVersions.noteId, noteId)
      )
    )
    .orderBy(
      desc(sql`CASE WHEN origin = 'auto' THEN 1 ELSE 0 END`),
      asc(markdownNoteVersions.createdAt),
      asc(markdownNoteVersions.id)
    );
  const excess = versions.slice(
    0,
    Math.max(0, versions.length - NOTE_VERSION_MAX)
  );
  if (excess.length) {
    await tx.delete(markdownNoteVersions).where(
      and(
        eq(markdownNoteVersions.userId, userId),
        inArray(
          markdownNoteVersions.id,
          excess.map(row => row.id)
        )
      )
    );
  }
}

export async function snapshotNote(
  tx: NoteTx,
  row: MarkdownNote,
  origin: NoteVersionOrigin,
  now = new Date()
): Promise<string | null> {
  const [version] = await tx
    .insert(markdownNoteVersions)
    .values({
      noteId: row.id,
      userId: row.userId,
      title: row.title,
      body: row.body,
      contentRevision: row.contentRevision,
      origin,
      createdAt: now,
    })
    .returning({ id: markdownNoteVersions.id });
  await pruneNoteVersions(tx, row.userId, row.id, now);
  return version.id;
}

export async function createNote(
  userId: number,
  input: {
    title: string;
    body: string;
    parentId: string | null;
    issue: { connectionId: number; issueKey: string } | null;
    kind?: NoteKind;
    /** The note's day as the browser counts it; today on the server's clock otherwise */
    notedOn?: string;
  }
): Promise<MarkdownNote> {
  const derived = noteDerived(input.title, input.body);
  const kind = input.kind ?? "note";
  return getDb().transaction(async tx => {
    await lockNoteTree(tx, userId);
    const parent = await activeParent(tx, userId, input.parentId);
    if (kind === "folder" && parent?.kind === "note") throw folderInNote();
    await checkPlacement(tx, userId, parent, []);
    const siblings = await tx
      .select({ id: markdownNotes.id })
      .from(markdownNotes)
      .where(
        and(
          eq(markdownNotes.userId, userId),
          isNull(markdownNotes.deletedAt),
          input.parentId
            ? eq(markdownNotes.parentId, input.parentId)
            : isNull(markdownNotes.parentId)
        )
      );
    const [row] = await tx
      .insert(markdownNotes)
      .values({
        userId,
        parentId: input.parentId,
        kind,
        position: siblings.length,
        title: input.title,
        body: input.body,
        bodyText: derived.bodyText,
        searchTitle: derived.searchTitle,
        searchText: derived.searchText,
        connectionId: input.issue?.connectionId ?? null,
        issueKey: input.issue?.issueKey ?? null,
        itemId: null,
        notedOn: kind === "note" ? (input.notedOn ?? dayKey(new Date())) : null,
      })
      .returning();
    // A folder goes after the folders already there, before the notes.
    if (kind === "folder") {
      await normalizeSiblings(tx, userId, input.parentId);
      return ownNote(tx, userId, row.id, true);
    }
    return row;
  });
}

export async function moveNote(
  userId: number,
  id: string,
  parentId: string | null,
  index: number
): Promise<NoteTreeItem> {
  return getDb().transaction(async tx => {
    await lockNoteTree(tx, userId);
    const row = await ownNote(tx, userId, id, true);
    const parent = await activeParent(tx, userId, parentId);
    if (row.kind === "folder" && parent?.kind === "note") throw folderInNote();
    const subtree = await noteSubtree(tx, userId, id);
    if (parentId && subtree.some(node => node.id === parentId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: t("server.notes.cycle"),
      });
    }
    await checkPlacement(tx, userId, parent, subtree);
    const oldParentId = row.parentId;
    const siblingRows = await tx
      .select({ id: markdownNotes.id, parentId: markdownNotes.parentId })
      .from(markdownNotes)
      .where(
        and(eq(markdownNotes.userId, userId), isNull(markdownNotes.deletedAt))
      )
      .orderBy(asc(markdownNotes.position), asc(markdownNotes.id));
    const oldSiblings = siblingRows
      .filter(s => s.parentId === oldParentId && s.id !== id)
      .map(s => s.id);
    const newSiblings = siblingRows
      .filter(s => s.parentId === parentId && s.id !== id)
      .map(s => s.id);
    newSiblings.splice(Math.min(index, newSiblings.length), 0, id);
    await tx
      .update(markdownNotes)
      .set({ parentId, updatedAt: new Date() })
      .where(and(eq(markdownNotes.id, id), eq(markdownNotes.userId, userId)));
    await normalizeSiblings(tx, userId, oldParentId, oldSiblings);
    await normalizeSiblings(tx, userId, parentId, newSiblings);
    const next = await ownNote(tx, userId, id, true);
    return noteTreeItem(next);
  });
}

/** A new title, over the revision it was shown with; the text stays as it is. */
export async function renameNote(
  userId: number,
  id: string,
  title: string,
  expectedRevision: number
): Promise<NoteUpdated | NoteConflict> {
  return getDb().transaction(async (tx): Promise<NoteUpdated | NoteConflict> => {
    const current = await ownNote(tx, userId, id);
    if (current.deletedAt)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.notes.deleted") });
    if (current.contentRevision !== expectedRevision)
      return { status: "conflict", current: noteDocument(current) };
    const derived = noteDerived(title, current.body);
    const [next] = await tx
      .update(markdownNotes)
      .set({
        title,
        searchTitle: derived.searchTitle,
        searchText: derived.searchText,
        contentRevision: sql`${markdownNotes.contentRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(markdownNotes.id, id),
          eq(markdownNotes.userId, userId),
          isNull(markdownNotes.deletedAt),
          eq(markdownNotes.contentRevision, expectedRevision)
        )
      )
      .returning();
    if (!next) return { status: "conflict", current: noteDocument(await ownNote(tx, userId, id)) };
    return { status: "updated", note: noteDocument(next) };
  });
}

/**
 * A note that only groups others becomes a folder: only while it has no text
 * (nothing is lost), links no issue, and does not sit in a note.
 */
export async function convertNoteToFolder(userId: number, id: string): Promise<NoteTreeItem> {
  return getDb().transaction(async tx => {
    await lockNoteTree(tx, userId);
    const row = await ownNote(tx, userId, id, true);
    if (row.kind === "folder") return noteTreeItem(row);
    if (row.body.trim())
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.notes.convertHasText") });
    if (row.issueKey)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.notes.convertLinked") });
    const parent = await activeParent(tx, userId, row.parentId);
    if (parent?.kind === "note") throw folderInNote();
    const derived = noteDerived(row.title, "");
    await tx
      .update(markdownNotes)
      .set({
        kind: "folder",
        body: "",
        bodyText: derived.bodyText,
        searchTitle: derived.searchTitle,
        searchText: derived.searchText,
        contentRevision: sql`${markdownNotes.contentRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(markdownNotes.id, id), eq(markdownNotes.userId, userId)));
    await normalizeSiblings(tx, userId, row.parentId);
    return noteTreeItem(await ownNote(tx, userId, id, true));
  });
}

export async function deleteNote(
  userId: number,
  id: string
): Promise<{ batch: string; count: number }> {
  return getDb().transaction(async tx => {
    await lockNoteTree(tx, userId);
    await ownNote(tx, userId, id, true);
    const subtree = await noteSubtree(tx, userId, id);
    const now = new Date();
    const batch = randomUUID();
    const changed = await tx
      .update(markdownNotes)
      .set({
        deletedAt: now,
        deleteBatch: batch,
        deleteRootId: id,
        updatedAt: now,
      })
      .where(
        and(
          eq(markdownNotes.userId, userId),
          isNull(markdownNotes.deletedAt),
          inArray(
            markdownNotes.id,
            subtree.map(node => node.id)
          )
        )
      )
      .returning({ id: markdownNotes.id });
    return { batch, count: changed.length };
  });
}

export async function restoreNoteBatch(
  userId: number,
  batch: string,
  toRoot: boolean
): Promise<{ ids: string[] }> {
  return getDb().transaction(async tx => {
    await lockNoteTree(tx, userId);
    const rows = await tx
      .select()
      .from(markdownNotes)
      .where(
        and(
          eq(markdownNotes.userId, userId),
          eq(markdownNotes.deleteBatch, batch),
          sql`${markdownNotes.deletedAt} IS NOT NULL`
        )
      );
    if (!rows.length) throw notFound();
    const root = rows.find(row => row.id === rows[0].deleteRootId);
    if (!root) throw notFound();
    let parentId = root.parentId;
    if (parentId) {
      const [parent] = await tx
        .select()
        .from(markdownNotes)
        .where(
          and(
            eq(markdownNotes.id, parentId),
            eq(markdownNotes.userId, userId),
            isNull(markdownNotes.deletedAt)
          )
        );
      if (!parent) {
        if (!toRoot)
          throw new TRPCError({
            code: "CONFLICT",
            message: t("server.notes.parentDeleted"),
          });
        parentId = null;
      }
    }
    const now = new Date();
    const restored = await tx
      .update(markdownNotes)
      .set({
        parentId: sql`CASE WHEN id = ${root.id} THEN ${parentId} ELSE parent_id END`,
        deletedAt: null,
        deleteBatch: null,
        deleteRootId: null,
        contentRevision: sql`${markdownNotes.contentRevision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(markdownNotes.userId, userId),
          eq(markdownNotes.deleteBatch, batch),
          inArray(
            markdownNotes.id,
            rows.map(row => row.id)
          )
        )
      )
      .returning({ id: markdownNotes.id });
    const siblings = await tx
      .select({ id: markdownNotes.id })
      .from(markdownNotes)
      .where(
        and(
          eq(markdownNotes.userId, userId),
          isNull(markdownNotes.deletedAt),
          parentId
            ? eq(markdownNotes.parentId, parentId)
            : isNull(markdownNotes.parentId)
        )
      )
      .orderBy(asc(markdownNotes.position), asc(markdownNotes.id));
    const ordered = siblings.map(row => row.id).filter(id => id !== root.id);
    ordered.splice(Math.min(root.position, ordered.length), 0, root.id);
    await normalizeSiblings(tx, userId, parentId, ordered);
    return { ids: restored.map(row => row.id) };
  });
}

export async function purgeMarkdownNotes(now = Date.now()): Promise<number> {
  const db = getDb();
  const users = await db
    .selectDistinct({ userId: markdownNotes.userId })
    .from(markdownNotes)
    .where(
      lt(markdownNotes.deletedAt, new Date(now - NOTE_TRASH_DAYS * 86_400_000))
    );
  let count = 0;
  for (const { userId } of users) {
    count += await db.transaction(async tx => {
      await lockNoteTree(tx, userId);
      const cutoff = new Date(now - NOTE_TRASH_DAYS * 86_400_000);
      const expired = await tx
        .select({ id: markdownNotes.id, batch: markdownNotes.deleteBatch })
        .from(markdownNotes)
        .where(
          and(
            eq(markdownNotes.userId, userId),
            lt(markdownNotes.deletedAt, cutoff)
          )
        );
      if (!expired.length) return 0;
      const ids = expired.map(row => row.id);
      const blockedParents = await tx
        .selectDistinct({ parentId: markdownNotes.parentId })
        .from(markdownNotes)
        .where(
          and(
            eq(markdownNotes.userId, userId),
            inArray(markdownNotes.parentId, ids),
            sql`(${markdownNotes.deletedAt} IS NULL OR ${markdownNotes.deletedAt} >= ${cutoff.getTime()})`
          )
        );
      const blocked = new Set(blockedParents.map(row => row.parentId));
      const eligible = expired.filter(row => !blocked.has(row.id));
      if (!eligible.length) return 0;
      const gone = await tx
        .delete(markdownNotes)
        .where(
          and(
            eq(markdownNotes.userId, userId),
            inArray(
              markdownNotes.id,
              eligible.map(row => row.id)
            )
          )
        )
        .returning({ id: markdownNotes.id });
      return gone.length;
    });
  }
  return count;
}
