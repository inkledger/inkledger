import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, permProcedure } from "../middleware";
import { alertSummary, readWebhook, saveWebhook, testWebhook, WEBHOOK_FORMATS } from "../ops/alerts";
import { UnsafeUrlError } from "../lib/security";
import { opsConfig } from "../ops/config";

/** What the settings show of a webhook: where it posts (the host only: the URL itself is a secret) and how. */
const shown = (hook: Awaited<ReturnType<typeof readWebhook>>) => (hook ? { host: new URL(hook.url).host, format: hook.format } : null);

/** Settings → Network: alerts firing now, and the outbound webhook alerts go to. */
export const alertsRouter = createRouter({
  summary: permProcedure("manageServer").query(async () => ({
    alerts: await alertSummary(),
    cooldownMin: opsConfig.alertCooldownMin,
    failuresThreshold: opsConfig.alertFailures,
  })),

  webhook: permProcedure("manageServer").query(async () => shown(await readWebhook())),

  /** Saves (or with null, removes) the webhook; a new URL gets a new signing secret, shown once. */
  setWebhook: permProcedure("manageServer")
    .input(z.object({ url: z.string().trim().url().max(2000), format: z.enum(WEBHOOK_FORMATS) }).nullable())
    .mutation(async ({ input }) => {
      const before = await readWebhook();
      try {
        const saved = await saveWebhook(input);
        return { webhook: shown(saved), secret: saved && saved.secret !== before?.secret ? saved.secret : null };
      } catch (e) {
        if (e instanceof UnsafeUrlError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),

  test: permProcedure("manageServer").mutation(async () => {
    try {
      await testWebhook();
      return { ok: true as const };
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
    }
  }),
});
