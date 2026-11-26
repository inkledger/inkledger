import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { t as tr } from "@contracts/i18n";
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_STATUSES,
  FEEDBACK_TITLE_MAX,
  FEEDBACK_TYPES,
} from "@contracts/feedback";
import { dayKey } from "@contracts/time";
import { createRouter, permProcedure, protectedProcedure } from "../middleware";
import { holds, withAccess, type Account } from "../queries/accounts";
import { record } from "../lib/audit";
import { serverBuild } from "../lib/appBuild";
import { addComment, commentsOf, createFeedback, shareLater, feedbackById, feedbackRow, listFeedback, setFeedbackStatus, type FeedbackFilter, type FeedbackView } from "../feedback/store";
import { feedbackJson, feedbackMarkdown } from "../feedback/export";
import { forwardQueued, setSharing, sharingAvailable, sharingEnabled } from "../feedback/upstream";

/** "Send now" at most every few minutes per server: the inbox keeps its own caps, this keeps clicks cheap. */
const SEND_NOW_GAP_MS = 5 * 60_000;
let lastSendNow = 0;

const status = z.enum(FEEDBACK_STATUSES);
const type = z.enum(FEEDBACK_TYPES);
const filter = z.object({ userId: z.number().int().positive().optional(), status: status.optional(), type: type.optional() });

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: tr("server.feedback.notFound") });

/** Whether `user` may read this feedback: their own, or anyone's with readFeedback. */
const mayRead = (user: Account, f: Pick<FeedbackView, "userId">) => f.userId === user.id || holds(user, "readFeedback");

/** One feedback for its reader, or NOT_FOUND (someone else's reads as missing, never as forbidden). */
async function readable(user: Account, id: number): Promise<FeedbackView> {
  const f = await feedbackById(id);
  if (!f || !mayRead(user, f)) throw notFound();
  return f;
}


/**
 * Feedback about the app (Info > Feedback): everyone sends and follows their own;
 * readFeedback reads everyone's; manageFeedback moves them through their states and
 * decides whether they may be shared with inkledger's developers (feedback/upstream.ts).
 */
export const feedbackRouter = createRouter({
  /** What the page needs to know before it draws: sharing on, and what the reader may do. */
  access: protectedProcedure.query(async ({ ctx }) => {
    const user = await withAccess(ctx.user);
    return { readAll: holds(user, "readFeedback"), manage: holds(user, "manageFeedback"), sharingAvailable: sharingAvailable(), sharing: await sharingEnabled() };
  }),

  /** The reader's own feedback, newest first. */
  mine: protectedProcedure.input(filter.omit({ userId: true }).optional()).query(({ ctx, input }) => listFeedback({ ...input, userId: ctx.user.id })),

  /** Everyone's feedback (readFeedback), filtered. */
  all: permProcedure("readFeedback").input(filter.optional()).query(({ input }) => listFeedback(input ?? {})),

  /** One feedback and its thread. */
  get: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const user = await withAccess(ctx.user);
    const f = await readable(user, input.id);
    const thread = (await commentsOf([f.id])).get(f.id) ?? [];
    return { ...f, thread, mine: f.userId === user.id, canManage: holds(user, "manageFeedback") };
  }),

  /** A new feedback of the caller's; the page and look are said by the page, the build by the server. */
  create: protectedProcedure
    .input(
      z.object({
        type,
        title: z.string().trim().min(1).max(FEEDBACK_TITLE_MAX),
        body: z.string().max(FEEDBACK_BODY_MAX).default(""),
        page: z.string().max(500).default(""),
        look: z.string().max(40).default(""),
        density: z.enum(["compact", "comfortable"]).default("compact"),
        share: z.boolean().default(false),
        shareScreenshot: z.boolean().default(false),
        /** A screenshot follows (POST /api/feedback/:id/screenshot). */
        screenshot: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sharing = input.share && (await sharingEnabled());
      if (input.share && !sharing) throw new TRPCError({ code: "PRECONDITION_FAILED", message: tr("server.feedback.sharingOff") });
      const row = await createFeedback(
        ctx.user.id,
        { type: input.type, title: input.title, body: input.body, page: input.page, appVersion: serverBuild() ?? "dev", look: input.look, density: input.density, shareConsent: sharing, shareScreenshot: sharing && input.shareScreenshot },
        sharing,
      );
      await record(ctx, "feedback.create", { target: { type: "feedback", id: row.id, ownerUserId: ctx.user.id }, after: { type: row.type, shared: sharing } });
      // Shared: queued, sent with the server's next batch (the maintenance cycle), never one call per feedback.
      return { id: row.id };
    }),

  /** The author shares one of their own later (consent given now), queued for the next batch. */
  share: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), shareScreenshot: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const f = await feedbackById(input.id);
      if (!f || f.userId !== ctx.user.id) throw notFound();
      if (!(await sharingEnabled())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: tr("server.feedback.sharingOff") });
      const queued = await shareLater(f.id, ctx.user.id, input.shareScreenshot);
      if (queued) await record(ctx, "feedback.share", { target: { type: "feedback", id: f.id, ownerUserId: ctx.user.id }, after: { shareScreenshot: input.shareScreenshot } });
      return { queued };
    }),

  /** A line in the thread: the author on their own, manageFeedback on anyone's. */
  comment: protectedProcedure.input(z.object({ id: z.number().int().positive(), body: z.string().trim().min(1).max(FEEDBACK_COMMENT_MAX) })).mutation(async ({ ctx, input }) => {
    const user = await withAccess(ctx.user);
    const f = await readable(user, input.id);
    const own = f.userId === user.id;
    if (!own && !holds(user, "manageFeedback")) throw new TRPCError({ code: "FORBIDDEN", message: tr("server.auth.notAllowed") });
    const origin = own ? "user" : "admin";
    await addComment(f, user.id, origin, input.body);
    await record(ctx, "feedback.comment", { target: { type: "feedback", id: f.id, ownerUserId: f.userId }, after: { origin } });
    return { ok: true };
  }),

  /** Moves a feedback through its states; a rejection says why. */
  setStatus: permProcedure("manageFeedback")
    .input(z.object({ id: z.number().int().positive(), status, reason: z.string().trim().max(FEEDBACK_COMMENT_MAX).optional() }))
    .mutation(async ({ ctx, input }) => {
      if (input.status === "rejected" && !input.reason) throw new TRPCError({ code: "BAD_REQUEST", message: tr("server.feedback.reasonRequired") });
      const row = await feedbackRow(input.id);
      if (!row) throw notFound();
      const changed = await setFeedbackStatus(row, input.status, { by: ctx.user.id, reason: input.reason });
      ctx.audit.set({ target: { type: "feedback", id: row.id, ownerUserId: row.userId }, after: { from: row.status, to: input.status } });
      return { changed: Boolean(changed) };
    }),

  /** Whether this server shares feedback (with its author's consent) with inkledger's developers. */
  setSharing: permProcedure("manageFeedback")
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.enabled && !sharingAvailable()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: tr("server.feedback.storeOff") });
      await setSharing(input.enabled);
      ctx.audit.set({ target: { type: "server", id: "feedback.sharing" }, after: { enabled: input.enabled } });
      return { enabled: input.enabled };
    }),

  /** The queued (consented) feedback sent now instead of at the next 6-hour round. */
  sendNow: permProcedure("manageFeedback").mutation(async ({ ctx }) => {
    if (!(await sharingEnabled())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: tr("server.feedback.sendNowOff") });
    const now = Date.now();
    if (now - lastSendNow < SEND_NOW_GAP_MS) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: tr("server.feedback.sendNowWait") });
    lastSendNow = now;
    const r = await forwardQueued({ now });
    ctx.audit.set({ target: { type: "server", id: "feedback.sendNow" }, after: r });
    return r;
  }),

  /**
   * Feedback as a file: the ones picked, or what a filter shows. Of the caller's own, or
   * (scope "all", readFeedback) of everyone's. Recorded.
   */
  export: protectedProcedure
    .input(z.object({ scope: z.enum(["mine", "all"]), format: z.enum(["markdown", "json"]), ids: z.array(z.number().int().positive()).max(500).optional(), filter: filter.optional() }))
    .mutation(async ({ ctx, input }) => {
      const user = await withAccess(ctx.user);
      if (input.scope === "all" && !holds(user, "readFeedback")) throw new TRPCError({ code: "FORBIDDEN", message: tr("server.auth.notAllowed") });
      const where: FeedbackFilter = { ...input.filter, ...(input.ids ? { ids: input.ids } : {}), ...(input.scope === "mine" ? { userId: user.id } : {}) };
      const rows = await listFeedback(where);
      const threads = await commentsOf(rows.map((r) => r.id));
      const items = rows.map((r) => ({ ...r, comments: threads.get(r.id) ?? [] }));
      await record(ctx, "feedback.export", { target: { type: "feedback", id: null }, after: { format: input.format, rows: items.length, scope: input.scope } });
      const name = `inkledger-feedback-${dayKey(new Date())}.${input.format === "json" ? "json" : "md"}`;
      return input.format === "json"
        ? { name, mime: "application/json", content: feedbackJson(items) }
        : { name, mime: "text/markdown", content: feedbackMarkdown(items) };
    }),
});
