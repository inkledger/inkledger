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
  // A server error of the tracker's (5xx) is no answer of its own, however it is wrapped.
  const status = e.status ?? (typeof cause?.status === "number" ? cause.status : undefined);
  if (status !== undefined && status >= 500) return false;
  if (cause === undefined || cause instanceof ProviderError) return true;
  return typeof cause?.status === "number" || cause?.providerKind === "readOnly";
}

/**
 * A write the service certainly didn't take: its own refusal, or refused before it left. No
 * answer, a cancel, an odd answer or a fault of ours leave it open: it may have landed.
 */
export function certainRefusal(e: unknown): boolean {
  return e instanceof ProviderError && !e.transient && e.kind !== "cancelled" && isRefusal(e);
}

// A client's fallback when the tracker said nothing of its own: "GitHub answered 429", "monday: answered 500".
const BARE_STATUS = /^(?:[A-Za-z][\w .-]*?:? )?answered \d{3}$/;
const REFUSED = ["auth", "forbidden", "notFound", "invalid", "conflict", "rateLimit"] as const;

/** A refusal's words: the tracker's own, or, where it gave none, the kind of refusal in the user's. */
function refusalWords(e: ProviderError): string {
  const kind = REFUSED.find((k) => k === e.kind);
  return kind && BARE_STATUS.test(e.message) ? t(`server.provider.refused.${kind}`) : e.message;
}

/**
 * A provider's error as the API answers it. A refusal: its kind's code and its words. A tracker
 * out of reach or too slow (no answer of its own): that code, in the user's words. Any other
 * fault: a server error in general words. Faults are logged here, with their details.
 */
export function providerTrpcError(e: ProviderError): TRPCError {
  if (isRefusal(e)) return new TRPCError({ code: CODES[e.kind], message: refusalWords(e), cause: e });
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
