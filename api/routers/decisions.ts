import { z } from "zod";
import { createRouter, protectedProcedure } from "../middleware";
import { TRPCError } from "@trpc/server";
import { t as tr } from "@contracts/i18n";
import { and, eq } from "drizzle-orm";
import { timers } from "@db/schema";
import { askTimerLogIn, dismiss, listDecisions, patchDraft } from "../decisions/store";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { act, epochOf, whoOf } from "./timers";

const ref = { id: z.uuid(), revision: z.number().int().nonnegative() };

/**
 * The questions the app owes the user an answer to, the same on every page
 * and device: listed, their drafts typed live, answered once.
 */
export const decisionsRouter = createRouter({
  list: protectedProcedure.query(({ ctx }) => listDecisions(ctx.user.id)),

  patchDraft: protectedProcedure
    .input(z.object({ id: z.uuid(), fields: z.record(z.string().max(40), z.unknown()).refine((f) => JSON.stringify(f).length <= 16_000, "draft too large") }))
    .mutation(({ ctx, input }) => {
      const w = whoOf(ctx);
      return patchDraft(ctx.user.id, input.id, input.fields, { client: w.client, label: w.label });
    }),

  /** Ask again to log a stopped timer, on every page (the open question if there is one). */
  askTimerLog: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const w = whoOf(ctx);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      return act(
        ctx.user.id,
        undefined,
        async (tx, decided) => {
          const [t] = await tx.select().from(timers).where(and(eq(timers.userId, ctx.user.id), eq(timers.connectionId, conn.id), eq(timers.issueKey, input.issueKey)));
          if (!t || t.state !== "paused") throw new TRPCError({ code: "CONFLICT", message: tr("server.decisions.notStopped", { key: input.issueKey }) });
          const d = await askTimerLogIn(tx, t, { client: w.client, label: w.label });
          decided(d);
          return { id: d.id, epoch: await epochOf(tx, ctx.user.id) };
        },
        w.client,
      );
    }),

  dismiss: protectedProcedure.input(z.object(ref)).mutation(async ({ ctx, input }) => {
    const w = whoOf(ctx);
    await dismiss(ctx.user.id, input, { client: w.client, label: w.label });
    return { ok: true };
  }),
});
