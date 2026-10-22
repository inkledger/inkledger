// A provider's error as the app's API answers it: the kind decides the
// code, the fields at fault ride along for the form that asked.
import { TRPCError } from "@trpc/server";
import { ProviderError, type ProviderErrorKind } from "./core/errors";
import { t } from "@contracts/i18n";

const CODES: Record<ProviderErrorKind, TRPCError["code"]> = {
  // The connection needs reconnecting, never the account signing in again
  auth: "PRECONDITION_FAILED",
  forbidden: "FORBIDDEN",
  invalid: "BAD_REQUEST",
  rateLimit: "TOO_MANY_REQUESTS",
  conflict: "CONFLICT",
  notFound: "NOT_FOUND",
  invalidCheckpoint: "INTERNAL_SERVER_ERROR",
  unavailable: "SERVICE_UNAVAILABLE",
  readOnly: "FORBIDDEN",
  cancelled: "CLIENT_CLOSED_REQUEST",
  timeout: "TIMEOUT",
  incompatible: "INTERNAL_SERVER_ERROR",
};

/**
 * A tracker's own refusal (said on purpose, or its HTTP answer, or the read-only guard), as
 * opposed to a fault normalizeError wrapped (a bug, an unknown error, no answer): only a
 * refusal's words are for the user; a fault stays a server error, logged, in general words.
 */
export function isRefusal(e: ProviderError): boolean {
  if (e.kind === "incompatible" || e.kind === "invalidCheckpoint") return false;
  const cause = e.cause as { status?: unknown; providerKind?: unknown } | undefined;
  if (cause === undefined || cause instanceof ProviderError) return true;
  return typeof cause?.status === "number" || cause?.providerKind === "readOnly";
}

/**
 * A provider's error as the API answers it. A refusal: its kind's code and its words. A tracker
 * out of reach or too slow (no answer of its own): that code, in the user's words. Any other
 * fault: a server error in general words. Faults are logged here, with their details.
 */
export function providerTrpcError(e: ProviderError): TRPCError {
  if (isRefusal(e)) return new TRPCError({ code: CODES[e.kind], message: e.message, cause: e });
  if (e.kind === "unavailable" || e.kind === "timeout") {
    console.warn(`[provider] ${e.kind}: ${e.message}`);
    return new TRPCError({ code: CODES[e.kind], message: t(e.kind === "timeout" ? "server.provider.slow" : "server.provider.unreachable"), cause: e });
  }
  console.error(e);
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: t("server.internal.error"), cause: e });
}

/** Runs a provider call, its ProviderError turned into the matching TRPCError (the original as cause). */
export async function providerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    throw providerTrpcError(e);
  }
}
