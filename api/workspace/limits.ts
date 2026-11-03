import { TRPCError } from "@trpc/server";
import { t } from "@contracts/i18n";
import { WorkspaceApplyError } from "@contracts/workspace/applyMachine";
import { createRateLimiter } from "../lib/security";

/** Per user: the local model, file imports, FlowMap batches and analysis cannot be called in a loop. */
export const WORKSPACE_LIMITS = {
  model: createRateLimiter(10, 60_000),
  imports: createRateLimiter(10, 60_000),
  ingest: createRateLimiter(120, 60_000),
  // Aggregating, exporting and ranking read every event of a layout: generous for a person, not for a loop.
  analysis: createRateLimiter(30, 60_000),
};

export function throttle(limiter: ReturnType<typeof createRateLimiter>, userId: number): void {
  const wait = limiter.hit(String(userId));
  if (wait > 0) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: t("server.workspace.tooMany", { count: wait }) });
}

/** A write a unique index refused (Postgres 23505, bare or wrapped by drizzle). */
export const uniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505";

/** A transition refused by the apply rules, or a race lost in the database: "changed, reload", in the user's words. */
export async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof WorkspaceApplyError || uniqueViolation(error)) {
      throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed"), cause: error instanceof Error ? error : undefined });
    }
    throw error;
  }
}
