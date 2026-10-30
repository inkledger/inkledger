import { activeBucket, issuesInBucket } from "../queries/buckets";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, inArray, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { buckets, connections, issueNotes, issues, mails, pinboardNotes, pinboards, todos, type Pinboard, type PinboardNote } from "@db/schema";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { openIssuesTagged, type FollowTag } from "../queries/myIssues";
import {
  type NoteColor,
  clampToCanvas,
  firstFreeSlot,
  freeSlotNear,
  randomTilt,
  boardDisplayName,
  defaultBoardName,
  MAX_BOARDS,
  MAX_NOTES,
  NOTE_COLORS,
} from "@contracts/pinboard";
import { t } from "@contracts/i18n";
import { mailCopyColumns } from "../mail/copies";

const color = z.enum(NOTE_COLORS);
const coord = z.number().finite();
const note = z.string().max(500);

const boardName = z.string().trim().min(1, { error: () => t("server.pinboard.nameRequired") }).max(60);
const boardIdInput = z.number().int().positive();

async function nextZ(boardId: number): Promise<number> {
  const [r] = await getDb()
    .select({ z: max(pinboardNotes.z) })
    .from(pinboardNotes)
    .where(eq(pinboardNotes.boardId, boardId));
  return (r?.z ?? 0) + 1;
}

/** Which tracker the board shows: one connection, or every one (0 or none). */
const scopeInput = { connectionId: z.number().int().nonnegative().optional() };

/**
 * The post-its the board shows, for its list and its counts alike (one filter,
 * so the two never differ): free notes always; an issue's when it is in the
 * device's bucket and, when one is chosen, on that tracker. Joined with issues.
 */
async function pinScope(userId: number, deviceId: string | undefined, connectionId?: number): Promise<SQL | undefined> {
  const inBucket = await issuesInBucket(userId, deviceId);
  const onTracker = connectionId ? eq(pinboardNotes.connectionId, connectionId) : undefined;
  const issueShown = and(inBucket, onTracker);
  return issueShown ? or(isNull(pinboardNotes.issueKey), issueShown) : undefined;
}

const pinnedIssue = and(eq(issues.userId, pinboardNotes.userId), eq(issues.connectionId, pinboardNotes.connectionId), eq(issues.key, pinboardNotes.issueKey));

/** The user's boards, creating the first one on demand. */
async function boardsOf(userId: number) {
  const db = getDb();
  const read = () =>
    db
      .select()
      .from(pinboards)
      .where(eq(pinboards.userId, userId))
      .orderBy(asc(pinboards.position), asc(pinboards.id));
  let rows = await read();
  if (rows.length === 0) {
    await db.insert(pinboards).values({ userId, name: defaultBoardName(), position: 0 });
    rows = await read();
  }
  return rows;
}

/**
 * The boards this device shows: with a bucket on, that bucket's and the ones
 * for every bucket; with none, all of them. A board of another bucket is
 * never shown under a bucket, so the filter never leaks foreign boards.
 */
async function visibleBoards(userId: number, deviceId: string | undefined) {
  const [boards, bucket] = await Promise.all([boardsOf(userId), activeBucket(userId, deviceId)]);
  return { bucket, boards: bucket === null ? boards : boards.filter((b) => b.bucketId === null || b.bucketId === bucket) };
}

/**
 * The asked board when this device shows it, else its first shown one, else
 * the asked one anyway (pinning from a page with no board in the bucket). A
 * board that is not the user's is NOT_FOUND, never swapped for one of theirs.
 */
async function shownBoard(userId: number, deviceId: string | undefined, boardId?: number) {
  const asked = await resolveBoard(userId, boardId);
  const { boards } = await visibleBoards(userId, deviceId);
  return boards.find((b) => b.id === asked.id) ?? boards[0] ?? asked;
}

/** A bucket of the user (a board's scope), or NOT_FOUND. */
async function ownBucket(userId: number, bucketId: number) {
  const [row] = await getDb()
    .select({ id: buckets.id })
    .from(buckets)
    .where(and(eq(buckets.id, bucketId), eq(buckets.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.bucketNotFound") });
}

/** A board of the user: the asked one, else the first. */
async function resolveBoard(userId: number, boardId?: number) {
  const boards = await boardsOf(userId);
  if (boardId === undefined) return boards[0];
  const b = boards.find((x) => x.id === boardId);
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.boardNotFound") });
  return b;
}

/** The tag a board follows, or null for a board pinned by hand. */
function followOf(b: Pick<Pinboard, "followField" | "followValue" | "followConnectionId">): FollowTag | null {
  return (b.followField === "label" || b.followField === "component") && b.followValue
    ? { field: b.followField, value: b.followValue, connectionId: b.followConnectionId }
    : null;
}

/** A board that follows a tag shows what the tracker says: nothing is pinned, moved or written on it. */
function writable(b: Pick<Pinboard, "followField" | "followValue" | "followConnectionId">) {
  if (followOf(b)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.followReadOnly") });
}

/**
 * Where a pin lands: the asked board, unless it follows a tag (the one last
 * shown on the device may): then the first board pinned by hand it shows.
 */
async function pinTarget(userId: number, deviceId: string | undefined, boardId?: number) {
  const asked = await shownBoard(userId, deviceId, boardId);
  if (!followOf(asked)) return asked;
  const { boards } = await visibleBoards(userId, deviceId);
  const free = boards.find((b) => !followOf(b)) ?? (await boardsOf(userId)).find((b) => !followOf(b));
  if (!free) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.followReadOnly") });
  return free;
}

/** A TODO hung on a board, as it is now (its text, day, done, its issue). */
type PinnedTodo = { id: number; text: string; dueOn: string | null; done: boolean; priority: number; steps: string; issueKey: string | null; connectionId: number | null };

/** A post-it as a board lists it: the stored one, with its issue as the catalogue knows it. */
type BoardNote = PinboardNote & {
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
  noteBody: string | null;
  noteCreatedAt: Date | null;
  todo: PinnedTodo | null;
  mail: PinnedMail | null;
};

/** A mail hung on a board: what opens it again. */
type PinnedMail = { id: number; subject: string; fromName: string | null; fromAddress: string | null; receivedAt: Date | null; webLink: string | null };

/**
 * The post-its a followed board shows: the open issues with its tag, laid out
 * in reading order, newest first; those the user moved or recoloured where and
 * as they were left (a placement row per issue). Their ids stay the issue's, negative.
 */
async function followedNotes(userId: number, deviceId: string | undefined, board: Pinboard, tag: FollowTag, connectionId?: number): Promise<BoardNote[]> {
  const rows = await getDb()
    .select({ id: issues.id, key: issues.key, connectionId: issues.connectionId, summary: issues.summary, status: issues.status, statusCategory: issues.statusCategory, updatedAt: issues.remoteUpdatedAt, syncedAt: issues.syncedAt })
    .from(issues)
    .where(and(await openIssuesTagged(userId, deviceId, tag), connectionId ? eq(issues.connectionId, connectionId) : undefined))
    .orderBy(sql`${issues.remoteUpdatedAt} DESC NULLS LAST`, asc(issues.key))
    .limit(MAX_NOTES);
  // Where the user put some of them, and in which colour: kept per board, by issue.
  const stored = await getDb()
    .select()
    .from(pinboardNotes)
    .where(and(eq(pinboardNotes.userId, userId), eq(pinboardNotes.boardId, board.id), isNull(pinboardNotes.issueNoteId), isNull(pinboardNotes.todoId), isNull(pinboardNotes.mailId)));
  const placedBy = new Map(stored.map((s) => [`${s.connectionId}:${s.issueKey}`, s]));
  const placed: { x: number; y: number }[] = rows.flatMap((r) => {
    const s = placedBy.get(`${r.connectionId}:${r.key}`);
    return s ? [{ x: s.x, y: s.y }] : [];
  });
  return rows.map((r, i) => {
    const s = placedBy.get(`${r.connectionId}:${r.key}`);
    const at = s ? { x: s.x, y: s.y } : firstFreeSlot(placed);
    if (!s) placed.push(at);
    const when = new Date(r.updatedAt ?? r.syncedAt);
    return {
      // Never a stored post-it's id: these aren't stored.
      id: -r.id,
      userId,
      boardId: board.id,
      connectionId: r.connectionId,
      itemId: null,
      issueKey: r.key,
      issueNoteId: null,
      todoId: null,
      mailId: null,
      note: "",
      color: s?.color ?? "yellow",
      ...at,
      // A steady tilt per issue, so the board doesn't shuffle on each read.
      rotation: ((r.id % 7) - 3) * 0.4 || 0.6,
      // Those the user moved above the others, the last moved on top.
      z: s ? s.z : -i,
      createdAt: when,
      updatedAt: when,
      summary: r.summary,
      status: r.status,
      statusCategory: r.statusCategory,
      noteBody: null,
      noteCreatedAt: null,
      todo: null,
      mail: null,
    };
  });
}

/**
 * Where an issue sits on a board that follows a tag, and in which colour: the
 * board's placement row for it, made at the first move. Nothing is written on it.
 */
async function place(userId: number, deviceId: string | undefined, boardId: number | undefined, issueId: number, input: { x?: number; y?: number; color?: NoteColor; note?: string; toFront?: boolean }) {
  if (boardId === undefined) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.noteNotFound") });
  const board = await resolveBoard(userId, boardId);
  if (!followOf(board)) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.noteNotFound") });
  if (input.note !== undefined) writable(board);
  const [issue] = await getDb()
    .select({ key: issues.key, connectionId: issues.connectionId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)));
  if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.noteNotFound") });
  const z = await nextZ(board.id);
  // Never placed and no place given (a colour first): where the board shows it now.
  const shown =
    input.x === undefined || input.y === undefined ? (await followedNotes(userId, deviceId, board, followOf(board)!)).find((n) => n.id === -issueId) : undefined;
  await getDb().transaction(async (tx) => {
    // One placement per issue and board, whatever the requests racing.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('pinboard-place'), ${board.id})`);
    const [had] = await tx
      .select()
      .from(pinboardNotes)
      .where(and(eq(pinboardNotes.boardId, board.id), eq(pinboardNotes.connectionId, issue.connectionId), eq(pinboardNotes.issueKey, issue.key), isNull(pinboardNotes.issueNoteId)));
    const pos = clampToCanvas(input.x ?? had?.x ?? shown?.x ?? 0, input.y ?? had?.y ?? shown?.y ?? 0);
    // Moved or raised: on top; only recoloured: where it was in the pile (a fresh one, with the laid-out ones).
    const raised = input.toFront || input.x !== undefined || input.y !== undefined;
    if (had) {
      await tx
        .update(pinboardNotes)
        .set({ ...pos, ...(input.color ? { color: input.color } : {}), ...(raised ? { z } : {}), updatedAt: new Date() })
        .where(eq(pinboardNotes.id, had.id));
    } else {
      await tx
        .insert(pinboardNotes)
        .values({ userId, boardId: board.id, issueKey: issue.key, connectionId: issue.connectionId, note: "", color: input.color ?? "yellow", ...pos, rotation: 0, z: raised ? z : (shown?.z ?? 0) });
    }
  });
}

/** A private note of the user (issue_notes). */
async function ownIssueNote(userId: number, id: number) {
  const [row] = await getDb()
    .select()
    .from(issueNotes)
    .where(and(eq(issueNotes.id, id), eq(issueNotes.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issueNotes.notFound") });
  return row;
}

async function own(userId: number, id: number) {
  const [row] = await getDb()
    .select()
    .from(pinboardNotes)
    .where(and(eq(pinboardNotes.id, id), eq(pinboardNotes.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.noteNotFound") });
  return row;
}

export const pinboardRouter = createRouter({
  /**
   * The boards this device shows (visibleBoards), each with its scope, its
   * switcher group (the active bucket's, for every bucket, or all), the
   * post-its it shows now (bucket and tracker: see pinScope) and those the
   * filter hides; the first board is created if the user has none.
   */
  boards: protectedProcedure.input(z.object(scopeInput).optional()).query(async ({ ctx, input }) => {
    const { bucket, boards } = await visibleBoards(ctx.user.id, ctx.deviceId);
    const scope = await pinScope(ctx.user.id, ctx.deviceId, input?.connectionId);
    const ids = boards.map((b) => b.id);
    const counts = ids.length
      ? await getDb()
          .select({
            boardId: pinboardNotes.boardId,
            all: count(),
            shown: scope ? sql<number>`count(*) filter (where ${scope})`.mapWith(Number) : count(),
          })
          .from(pinboardNotes)
          .leftJoin(issues, pinnedIssue)
          .where(and(eq(pinboardNotes.userId, ctx.user.id), inArray(pinboardNotes.boardId, ids)))
          .groupBy(pinboardNotes.boardId)
      : [];
    const by = new Map(counts.map((c) => [c.boardId, c]));
    const names = new Map(
      (await getDb().select({ id: buckets.id, name: buckets.name }).from(buckets).where(eq(buckets.userId, ctx.user.id))).map((b) => [b.id, b.name]),
    );
    // A followed board counts the issues it shows (capped as it draws them).
    const followed = new Map<number, number>();
    for (const b of boards) {
      const tag = followOf(b);
      if (!tag) continue;
      const [r] = await getDb()
        .select({ n: count() })
        .from(issues)
        .where(and(await openIssuesTagged(ctx.user.id, ctx.deviceId, tag), input?.connectionId ? eq(issues.connectionId, input.connectionId) : undefined));
      followed.set(b.id, Math.min(MAX_NOTES, r?.n ?? 0));
    }
    return boards.map((b) => {
      const c = by.get(b.id);
      const tag = followOf(b);
      return {
        id: b.id,
        name: boardDisplayName(b.name),
        bucket: b.bucketId === null ? null : { id: b.bucketId, name: names.get(b.bucketId) ?? "" },
        // Its place in the switcher, by the very bucket that chose the boards (never a stale copy of it).
        group: bucket === null ? ("all" as const) : b.bucketId === null ? ("shared" as const) : ("bucket" as const),
        follow: tag,
        count: tag ? (followed.get(b.id) ?? 0) : (c?.shown ?? 0),
        hidden: tag ? 0 : (c?.all ?? 0) - (c?.shown ?? 0),
      };
    });
  }),

  /** Moves a board to one bucket, or to every bucket (null). */
  setBoardScope: protectedProcedure
    .input(z.object({ id: boardIdInput, bucketId: z.number().int().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const b = await resolveBoard(ctx.user.id, input.id);
      if (input.bucketId !== null) await ownBucket(ctx.user.id, input.bucketId);
      await getDb().update(pinboards).set({ bucketId: input.bucketId }).where(eq(pinboards.id, b.id));
      return { ok: true };
    }),

  /**
   * A new board: in the device's bucket unless told otherwise (null: every
   * bucket); pinned by hand, or following a tag (a label or a component, on
   * one tracker or on every one).
   */
  createBoard: protectedProcedure
    .input(
      z.object({
        name: boardName,
        bucketId: z.number().int().positive().nullable().optional(),
        follow: z
          .object({
            field: z.enum(["label", "component"]),
            value: z.string().trim().min(1).max(200),
            connectionId: z.number().int().positive().nullable().default(null),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
    const boards = await boardsOf(ctx.user.id);
    const bucketId = input.bucketId === undefined ? await activeBucket(ctx.user.id, ctx.deviceId) : input.bucketId;
    if (bucketId !== null) await ownBucket(ctx.user.id, bucketId);
    if (input.follow?.connectionId) {
      const [own] = await getDb()
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, input.follow.connectionId), eq(connections.userId, ctx.user.id)));
      if (!own) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.trackerNotFound") });
    }
    if (boards.length >= MAX_BOARDS) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.maxBoards", { count: MAX_BOARDS }) });
    }
    const [row] = await getDb()
      .insert(pinboards)
      .values({
        userId: ctx.user.id,
        name: input.name,
        position: Math.max(0, ...boards.map((b) => b.position)) + 1,
        bucketId,
        ...(input.follow ? { followField: input.follow.field, followValue: input.follow.value, followConnectionId: input.follow.connectionId } : {}),
      })
      .returning({ id: pinboards.id });
    return { id: row.id };
  }),

  renameBoard: protectedProcedure
    .input(z.object({ id: boardIdInput, name: boardName }))
    .mutation(async ({ ctx, input }) => {
      const b = await resolveBoard(ctx.user.id, input.id);
      await getDb().update(pinboards).set({ name: input.name }).where(eq(pinboards.id, b.id));
      return { ok: true };
    }),

  /** Delete a board and its notes; the last one stays. */
  deleteBoard: protectedProcedure.input(z.object({ id: boardIdInput })).mutation(async ({ ctx, input }) => {
    await boardsOf(ctx.user.id);
    // Checked and deleted under the user's board lock: two deletes at once can't both
    // see another board pinned by hand and leave none.
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pinboards'), ${ctx.user.id})`);
      const boards = await tx.select().from(pinboards).where(eq(pinboards.userId, ctx.user.id));
      if (!boards.some((b) => b.id === input.id)) {
        throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.boardNotFound") });
      }
      // One board pinned by hand always stays: where a pin lands.
      const free = boards.filter((b) => !followOf(b));
      if (boards.length === 1 || (free.length === 1 && free[0].id === input.id)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.needBoard") });
      }
      await tx.delete(pinboardNotes).where(eq(pinboardNotes.boardId, input.id));
      await tx.delete(pinboards).where(eq(pinboards.id, input.id));
    });
    return { ok: true };
  }),

  /** Every post-it of a board, with the issue as known in the catalog. */
  list: protectedProcedure
    .input(z.object({ boardId: boardIdInput.optional(), ...scopeInput }).optional())
    .query(async ({ ctx, input }) => {
      const board = await shownBoard(ctx.user.id, ctx.deviceId, input?.boardId);
      const tag = followOf(board);
      if (tag) return followedNotes(ctx.user.id, ctx.deviceId, board, tag, input?.connectionId);
      // The device's bucket and the tracker chosen: issues outside them step off the board (free notes stay).
      const scope = await pinScope(ctx.user.id, ctx.deviceId, input?.connectionId);
      const rows = await getDb()
        .select({
          note: pinboardNotes,
          summary: issues.summary,
          status: issues.status,
          statusCategory: issues.statusCategory,
          noteBody: issueNotes.body,
          noteCreatedAt: issueNotes.createdAt,
          todo: todos,
          mail: { id: mails.id, subject: mails.subject, fromName: mails.fromName, fromAddress: mails.fromAddress, receivedAt: mails.receivedAt, webLink: mails.webLink, ...mailCopyColumns },
        })
        .from(pinboardNotes)
        .leftJoin(issues, pinnedIssue)
        .leftJoin(issueNotes, eq(issueNotes.id, pinboardNotes.issueNoteId))
        .leftJoin(todos, eq(todos.id, pinboardNotes.todoId))
        .leftJoin(mails, eq(mails.id, pinboardNotes.mailId))
        .where(and(eq(pinboardNotes.userId, ctx.user.id), eq(pinboardNotes.boardId, board.id), scope))
        .orderBy(asc(pinboardNotes.z), asc(pinboardNotes.id));
      return rows.map((r): BoardNote => ({
        ...r.note,
        summary: r.summary ?? null,
        status: r.status ?? null,
        statusCategory: r.statusCategory ?? null,
        // A private note hung here: its text and date (the post-it's own note stays empty).
        noteBody: r.noteBody ?? null,
        noteCreatedAt: r.noteCreatedAt ?? null,
        // A TODO hung here: as it is now (ticked, planned or rewritten from its list too).
        todo: r.todo
          ? {
              id: r.todo.id,
              text: r.todo.text,
              dueOn: r.todo.dueOn,
              done: r.todo.doneAt !== null,
              priority: r.todo.priority,
              steps: r.todo.steps,
              issueKey: r.todo.issueKey,
              connectionId: r.todo.connectionId,
            }
          : null,
        // A mail hung here: its subject and the link back to it.
        mail: r.mail?.id != null ? r.mail : null,
      }));
    }),

  /**
   * Pin an issue (once per board: pinning it again brings it to the front)
   * or a free note. Without coordinates it goes to the first free slot.
   */
  add: protectedProcedure
    .input(
      z.object({
        boardId: boardIdInput.optional(),
        issueKey: issueKeyInput.optional(),
        /** The issue's connection (needed when the key is on two). */
        connectionId: z.number().int().positive().optional(),
        note: note.default(""),
        color: color.default("yellow"),
        x: coord.optional(),
        y: coord.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const board = await pinTarget(ctx.user.id, ctx.deviceId, input.boardId);
      const connectionId = input.issueKey ? (await issueConnection(ctx.user.id, input.issueKey, input.connectionId)).id : undefined;
      const mine = await db
        .select({ id: pinboardNotes.id, issueKey: pinboardNotes.issueKey, connectionId: pinboardNotes.connectionId, issueNoteId: pinboardNotes.issueNoteId, x: pinboardNotes.x, y: pinboardNotes.y })
        .from(pinboardNotes)
        .where(eq(pinboardNotes.boardId, board.id));
      const z = await nextZ(board.id);
      // The issue's own post-it (not one of its private notes hung beside it).
      const existing = input.issueKey ? mine.find((m) => m.issueKey === input.issueKey && m.connectionId === connectionId && m.issueNoteId === null) : undefined;
      if (existing) {
        const pos =
          input.x !== undefined && input.y !== undefined
            ? clampToCanvas(input.x, input.y)
            : { x: existing.x, y: existing.y };
        await db
          .update(pinboardNotes)
          .set({ ...pos, z, updatedAt: new Date() })
          .where(eq(pinboardNotes.id, existing.id));
        return { id: existing.id, existed: true, boardId: board.id, boardName: boardDisplayName(board.name) };
      }
      if (mine.length >= MAX_NOTES) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: t("server.pinboard.boardFullNotes", { count: MAX_NOTES }),
        });
      }
      const pos =
        input.x !== undefined && input.y !== undefined
          ? clampToCanvas(input.x, input.y)
          : firstFreeSlot(mine);
      const [row] = await db
        .insert(pinboardNotes)
        .values({
          userId: ctx.user.id,
          boardId: board.id,
          issueKey: input.issueKey ?? null,
          connectionId: connectionId ?? null,
          note: input.note,
          color: input.color,
          ...pos,
          rotation: randomTilt(),
          z,
        })
        .returning({ id: pinboardNotes.id });
      return { id: row.id, existed: false, boardId: board.id, boardName: boardDisplayName(board.name) };
    }),

  /**
   * Hang a private note on a board, beside its issue's post-it (pinned too if
   * it is not there yet), tied by a red string. Again: brought to the front.
   */
  pinNote: protectedProcedure
    .input(z.object({ noteId: z.number().int().positive(), boardId: boardIdInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const n = await ownIssueNote(ctx.user.id, input.noteId);
      const board = await pinTarget(ctx.user.id, ctx.deviceId, input.boardId);
      const mine = await db
        .select({ id: pinboardNotes.id, issueKey: pinboardNotes.issueKey, connectionId: pinboardNotes.connectionId, issueNoteId: pinboardNotes.issueNoteId, x: pinboardNotes.x, y: pinboardNotes.y })
        .from(pinboardNotes)
        .where(eq(pinboardNotes.boardId, board.id));
      const already = mine.find((m) => m.issueNoteId === n.id);
      if (already) {
        await db.update(pinboardNotes).set({ z: await nextZ(board.id), updatedAt: new Date() }).where(eq(pinboardNotes.id, already.id));
        return { id: already.id, existed: true, boardId: board.id, boardName: boardDisplayName(board.name) };
      }
      let issue = mine.find((m) => m.issueKey === n.issueKey && m.connectionId === n.connectionId && m.issueNoteId === null);
      if (mine.length + (issue ? 1 : 2) > MAX_NOTES) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.boardFullNotes", { count: MAX_NOTES }) });
      }
      if (!issue) {
        const pos = firstFreeSlot(mine);
        const [row] = await db
          .insert(pinboardNotes)
          .values({ userId: ctx.user.id, boardId: board.id, issueKey: n.issueKey, connectionId: n.connectionId, note: "", color: "yellow", ...pos, rotation: randomTilt(), z: await nextZ(board.id) })
          .returning({ id: pinboardNotes.id });
        issue = { id: row.id, issueKey: n.issueKey, connectionId: n.connectionId, issueNoteId: null, ...pos };
        mine.push(issue);
      }
      const [row] = await db
        .insert(pinboardNotes)
        .values({
          userId: ctx.user.id,
          boardId: board.id,
          issueKey: n.issueKey,
          connectionId: n.connectionId,
          issueNoteId: n.id,
          note: "",
          color: "pink",
          ...freeSlotNear(issue, mine.filter((m) => m.id !== issue.id)),
          rotation: randomTilt(),
          z: await nextZ(board.id),
        })
        .returning({ id: pinboardNotes.id });
      return { id: row.id, existed: false, boardId: board.id, boardName: boardDisplayName(board.name) };
    }),

  /**
   * Hang a TODO on a board (once per board: again, it comes to the front). Its
   * post-it shows the TODO as it is, and ticking or rewriting it there is done
   * on the TODO. Its issue is read through it: the post-it has none of its own.
   */
  pinTodo: protectedProcedure
    .input(z.object({ todoId: z.number().int().positive(), boardId: boardIdInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [todo] = await db.select().from(todos).where(and(eq(todos.id, input.todoId), eq(todos.userId, ctx.user.id)));
      if (!todo) throw new TRPCError({ code: "NOT_FOUND", message: t("server.todos.notFound") });
      const board = await pinTarget(ctx.user.id, ctx.deviceId, input.boardId);
      const mine = await db.select({ id: pinboardNotes.id, todoId: pinboardNotes.todoId, x: pinboardNotes.x, y: pinboardNotes.y }).from(pinboardNotes).where(eq(pinboardNotes.boardId, board.id));
      const already = mine.find((m) => m.todoId === todo.id);
      if (already) {
        await db.update(pinboardNotes).set({ z: await nextZ(board.id), updatedAt: new Date() }).where(eq(pinboardNotes.id, already.id));
        return { id: already.id, existed: true, boardId: board.id, boardName: boardDisplayName(board.name) };
      }
      if (mine.length >= MAX_NOTES) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.boardFullNotes", { count: MAX_NOTES }) });
      const [row] = await db
        .insert(pinboardNotes)
        .values({ userId: ctx.user.id, boardId: board.id, todoId: todo.id, note: "", color: "green", ...firstFreeSlot(mine), rotation: randomTilt(), z: await nextZ(board.id) })
        .returning({ id: pinboardNotes.id });
      return { id: row.id, existed: false, boardId: board.id, boardName: boardDisplayName(board.name) };
    }),

  /** Hangs a pinned mail on a board (once per board: again brings it to the front). */
  pinMail: protectedProcedure
    .input(z.object({ mailId: z.number().int().positive(), boardId: boardIdInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [mail] = await db.select({ id: mails.id }).from(mails).where(and(eq(mails.id, input.mailId), eq(mails.userId, ctx.user.id)));
      if (!mail) throw new TRPCError({ code: "NOT_FOUND", message: t("server.mails.notFound") });
      const board = await pinTarget(ctx.user.id, ctx.deviceId, input.boardId);
      const mine = await db.select({ id: pinboardNotes.id, mailId: pinboardNotes.mailId, x: pinboardNotes.x, y: pinboardNotes.y }).from(pinboardNotes).where(eq(pinboardNotes.boardId, board.id));
      const already = mine.find((m) => m.mailId === mail.id);
      if (already) {
        await db.update(pinboardNotes).set({ z: await nextZ(board.id), updatedAt: new Date() }).where(eq(pinboardNotes.id, already.id));
        return { id: already.id, existed: true, boardId: board.id, boardName: boardDisplayName(board.name) };
      }
      if (mine.length >= MAX_NOTES) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.boardFullNotes", { count: MAX_NOTES }) });
      const [row] = await db
        .insert(pinboardNotes)
        .values({ userId: ctx.user.id, boardId: board.id, mailId: mail.id, note: "", color: "blue", ...firstFreeSlot(mine), rotation: randomTilt(), z: await nextZ(board.id) })
        .returning({ id: pinboardNotes.id });
      return { id: row.id, existed: false, boardId: board.id, boardName: boardDisplayName(board.name) };
    }),

  /**
   * The tags a board can follow: the labels and components of the user's open
   * issues, each with how many carry it, most used first.
   */
  tags: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb()
      .select({ connectionId: issues.connectionId, labels: issues.labels, components: issues.components })
      .from(issues)
      .where(await openIssuesTagged(ctx.user.id, ctx.deviceId, null));
    const counted = new Map<string, { field: "label" | "component"; value: string; count: number }>();
    const add = (field: "label" | "component", raw: string) => {
      let values: unknown;
      try {
        values = JSON.parse(raw);
      } catch {
        return;
      }
      if (!Array.isArray(values)) return;
      for (const v of new Set(values.filter((x): x is string => typeof x === "string" && x.trim() !== ""))) {
        const k = `${field}:${v}`;
        const c = counted.get(k) ?? { field, value: v, count: 0 };
        c.count++;
        counted.set(k, c);
      }
    };
    for (const r of rows) {
      add("label", r.labels);
      add("component", r.components);
    }
    return [...counted.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }),

  /**
   * Move, raise, write on or recolour a post-it. On a board that follows a tag
   * (a negative id, its issue's, with `boardId`): moved and recoloured only,
   * kept as that board's placement of the issue.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number().int(),
        /** A followed board's post-it: the board it is on. */
        boardId: boardIdInput.optional(),
        x: coord.optional(),
        y: coord.optional(),
        note: note.optional(),
        color: color.optional(),
        toFront: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.id < 0) {
        await place(ctx.user.id, ctx.deviceId, input.boardId, -input.id, input);
        return { ok: true };
      }
      const row = await own(ctx.user.id, input.id);
      const pos =
        input.x !== undefined || input.y !== undefined
          ? clampToCanvas(input.x ?? row.x, input.y ?? row.y)
          : {};
      // A TODO's text lives on the TODO: written here, it changes in its list too.
      if (row.todoId !== null && input.note?.trim()) {
        await getDb()
          .update(todos)
          .set({ text: input.note.trim().slice(0, 500), updatedAt: new Date() })
          .where(and(eq(todos.id, row.todoId), eq(todos.userId, ctx.user.id)));
      }
      // A private note's text lives on the note: written here, it changes there too.
      const toNote = (row.issueNoteId !== null || row.todoId !== null) && input.note !== undefined;
      if (toNote && row.issueNoteId !== null && input.note?.trim()) {
        await getDb()
          .update(issueNotes)
          .set({ body: input.note.trim(), updatedAt: new Date() })
          .where(and(eq(issueNotes.id, row.issueNoteId), eq(issueNotes.userId, ctx.user.id)));
      }
      await getDb()
        .update(pinboardNotes)
        .set({
          ...pos,
          ...(input.note !== undefined && !toNote ? { note: input.note } : {}),
          ...(input.color ? { color: input.color } : {}),
          ...(input.toFront && row.boardId ? { z: await nextZ(row.boardId) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(pinboardNotes.id, row.id));
      return { ok: true };
    }),

  /**
   * Where an issue is pinned: every board this device shows, each with the
   * issue's own post-it on it (null when it isn't there), and whether the
   * device's bucket hides the issue (pinned, it wouldn't show).
   */
  where: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const { boards } = await visibleBoards(ctx.user.id, ctx.deviceId);
      const pinned = await getDb()
        .select({ id: pinboardNotes.id, boardId: pinboardNotes.boardId })
        .from(pinboardNotes)
        .where(
          and(
            eq(pinboardNotes.userId, ctx.user.id),
            eq(pinboardNotes.connectionId, conn.id),
            eq(pinboardNotes.issueKey, input.issueKey),
            isNull(pinboardNotes.issueNoteId),
          ),
        );
      const on = new Map(pinned.map((p) => [p.boardId, p.id]));
      const inBucket = await issuesInBucket(ctx.user.id, ctx.deviceId);
      const shown = inBucket
        ? (
            await getDb()
              .select({ id: issues.id })
              .from(issues)
              .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, conn.id), eq(issues.key, input.issueKey), inBucket))
              .limit(1)
          ).length > 0
        : true;
      return {
        connectionId: conn.id,
        hiddenByBucket: !shown,
        // A followed board shows what its tag says: not a place to pin.
        boards: boards.filter((b) => !followOf(b)).map((b) => ({ id: b.id, name: boardDisplayName(b.name), noteId: on.get(b.id) ?? null })),
      };
    }),

  /** Unpin an issue from one board (its own post-it). Returns it so "Undo" can put it back. */
  unpinIssue: protectedProcedure
    .input(z.object({ boardId: boardIdInput, issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const board = await resolveBoard(ctx.user.id, input.boardId);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const [row] = await getDb()
        .delete(pinboardNotes)
        .where(
          and(
            eq(pinboardNotes.userId, ctx.user.id),
            eq(pinboardNotes.boardId, board.id),
            eq(pinboardNotes.connectionId, conn.id),
            eq(pinboardNotes.issueKey, input.issueKey),
            isNull(pinboardNotes.issueNoteId),
          ),
        )
        .returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.pinboard.noteNotFound") });
      return row;
    }),

  /**
   * A post-it to another board, moved or copied: with its note, colour, issue
   * and private note, on the first free spot there. Already there (the same
   * issue, the same private note): that one comes to the front, never a double.
   * A move returns the post-it it took away, for "Undo".
   */
  copy: protectedProcedure
    .input(z.object({ id: z.number().int(), boardId: boardIdInput, move: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const row = await own(ctx.user.id, input.id);
      const target = await resolveBoard(ctx.user.id, input.boardId);
      writable(target);
      if (target.id === row.boardId) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.pinboard.sameBoard") });
      const z = await nextZ(target.id);
      return getDb().transaction(async (tx) => {
        const there = await tx
          .select({ id: pinboardNotes.id, issueKey: pinboardNotes.issueKey, connectionId: pinboardNotes.connectionId, issueNoteId: pinboardNotes.issueNoteId, todoId: pinboardNotes.todoId, mailId: pinboardNotes.mailId, x: pinboardNotes.x, y: pinboardNotes.y })
          .from(pinboardNotes)
          .where(eq(pinboardNotes.boardId, target.id));
        const twin = there.find((m) =>
          row.todoId !== null
            ? m.todoId === row.todoId
            : row.mailId !== null
              ? m.mailId === row.mailId
            : row.issueNoteId !== null
              ? m.issueNoteId === row.issueNoteId
              : row.issueKey !== null && m.issueKey === row.issueKey && m.connectionId === row.connectionId && m.issueNoteId === null,
        );
        let id: number;
        if (twin) {
          await tx.update(pinboardNotes).set({ z, updatedAt: new Date() }).where(eq(pinboardNotes.id, twin.id));
          id = twin.id;
        } else {
          if (there.length >= MAX_NOTES) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.boardFullNotes", { count: MAX_NOTES }) });
          const [made] = await tx
            .insert(pinboardNotes)
            .values({
              userId: ctx.user.id,
              boardId: target.id,
              issueKey: row.issueKey,
              connectionId: row.connectionId,
              issueNoteId: row.issueNoteId,
              todoId: row.todoId,
              mailId: row.mailId,
              note: row.note,
              color: row.color,
              ...firstFreeSlot(there),
              rotation: randomTilt(),
              z,
            })
            .returning({ id: pinboardNotes.id });
          id = made.id;
        }
        if (input.move) await tx.delete(pinboardNotes).where(eq(pinboardNotes.id, row.id));
        return { id, existed: !!twin, boardId: target.id, boardName: boardDisplayName(target.name), removed: input.move ? row : null };
      });
    }),

  /** Unpin. Returns the post-it so "Undo" can put it back as it was. */
  remove: protectedProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
    const row = await own(ctx.user.id, input.id);
    await getDb().delete(pinboardNotes).where(eq(pinboardNotes.id, row.id));
    return row;
  }),

  /** Put back a post-it removed by mistake (same board, place, tilt and note). */
  restore: protectedProcedure
    .input(
      z.object({
        boardId: boardIdInput,
        issueKey: issueKeyInput.nullable(),
        connectionId: z.number().int().positive().optional(),
        /** A private note's post-it: hung again (the note must still exist). */
        issueNoteId: z.number().int().positive().nullable().optional(),
        /** A TODO's post-it: hung again while the TODO is there (else a free note with its words). */
        todoId: z.number().int().positive().nullable().optional(),
        note,
        color,
        x: coord,
        y: coord,
        rotation: z.number().min(-10).max(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Undo puts it back where it was, whatever the device shows now.
      const board = await resolveBoard(ctx.user.id, input.boardId);
      writable(board);
      if (input.issueNoteId) await ownIssueNote(ctx.user.id, input.issueNoteId);
      const [todo] = input.todoId
        ? await getDb().select().from(todos).where(and(eq(todos.id, input.todoId), eq(todos.userId, ctx.user.id)))
        : [];
      const connectionId = input.issueKey ? (await issueConnection(ctx.user.id, input.issueKey, input.connectionId)).id : null;
      const [c] = await getDb()
        .select({ n: sql<number>`count(*)` })
        .from(pinboardNotes)
        .where(eq(pinboardNotes.boardId, board.id));
      if ((c?.n ?? 0) >= MAX_NOTES) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.pinboard.boardFull") });
      }
      await getDb()
        .insert(pinboardNotes)
        .values({
          userId: ctx.user.id,
          boardId: board.id,
          issueKey: input.issueKey,
          connectionId,
          issueNoteId: input.issueNoteId ?? null,
          todoId: todo?.id ?? null,
          note: input.note,
          color: input.color,
          ...clampToCanvas(input.x, input.y),
          rotation: input.rotation,
          z: await nextZ(board.id),
        });
      return { ok: true };
    }),

  /** A free post-it became an issue: it now points to it. */
  link: protectedProcedure
    .input(z.object({ id: z.number().int(), issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const row = await own(ctx.user.id, input.id);
      // A TODO's post-it follows its TODO's issue: tie the TODO instead.
      if (row.todoId !== null) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.pinboard.todoLink") });
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      await getDb()
        .update(pinboardNotes)
        .set({ issueKey: input.issueKey, connectionId: conn.id, updatedAt: new Date() })
        .where(eq(pinboardNotes.id, row.id));
      return { ok: true };
    }),
});
