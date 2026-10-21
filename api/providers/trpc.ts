// A provider's error as the app's API answers it: the kind decides the
// code, the fields at fault ride along for the form that asked.
import { TRPCError } from "@trpc/server";
import { ProviderError, type ProviderErrorKind } from "./core/errors";

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

/** Runs a provider call, its ProviderError turned into the matching TRPCError (the original as cause). */
export async function providerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    throw new TRPCError({ code: CODES[e.kind], message: e.message, cause: e });
  }
}
