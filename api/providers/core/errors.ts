// What can go wrong talking to a service, in one vocabulary for every
// adapter: the engine decides from the kind alone (retry, wait, re-read,
// ask the user to reconnect), never from a provider's status codes.

export type ProviderErrorKind =
  /** The credentials are refused (expired token, changed password): the connection needs the user */
  | "auth"
  /** Signed in, but not allowed to do this (permissions, plan) */
  | "forbidden"
  /** The service refuses what was asked (a required field, a value it doesn't take) */
  | "invalid"
  /** Too many calls: wait (retryAfterMs) */
  | "rateLimit"
  /** Someone changed it meanwhile (version, lock): read again, then decide */
  | "conflict"
  | "notFound"
  /** A checkpoint or page token the adapter can't use (other format, expired, corrupt): read everything again */
  | "invalidCheckpoint"
  /** The service can't be reached or answers with a server error: try later */
  | "unavailable"
  /** The server is read-only (PROVIDERS_READ_ONLY) */
  | "readOnly"
  /** The caller gave up (its AbortSignal): nothing to retry */
  | "cancelled"
  /** No answer in time: may have landed or not (retry only what is protected) */
  | "timeout"
  /** The service (or the adapter) answered outside the contract: an API change or an adapter bug */
  | "incompatible";

export type RateLimit = {
  /** Wait this long before the next call */
  retryAfterMs?: number;
  /** Calls left in the current window */
  remaining?: number;
  /** When the window resets (epoch ms) */
  resetAt?: number;
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly rateLimit?: RateLimit;
  /** The fields the service objected to, by its field ids (invalid) */
  readonly fields?: Record<string, string>;

  constructor(kind: ProviderErrorKind, message: string, extra: { status?: number; rateLimit?: RateLimit; fields?: Record<string, string>; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = extra.status;
    this.rateLimit = extra.rateLimit;
    this.fields = extra.fields;
  }

  /** Whether trying the same call again later can work (a timeout only for protected calls: see types.ts). */
  get transient() {
    return this.kind === "rateLimit" || this.kind === "unavailable" || this.kind === "timeout";
  }
}

/** The kind an HTTP answer means, for adapters of HTTP APIs. */
export function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "notFound";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rateLimit";
  if (status >= 500) return "unavailable";
  return "invalid";
}

/** Why a write was refused before it left: the whole server is read-only, or this connection may not write. */
export type ReadOnlyCause = "server" | "connection";

/** The cause a refused write was marked with (http.ts), through the error's causes. */
export function readOnlyCauseOf(e: unknown): ReadOnlyCause | undefined {
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 5; x = (x as { cause?: unknown }).cause, i++) {
    const c = (x as { readOnlyCause?: unknown }).readOnlyCause;
    if (c === "server" || c === "connection") return c;
  }
  return undefined;
}

/**
 * Any error from an adapter call as a ProviderError (the registry's binding
 * applies it at the boundary): a ProviderError as is; the caller's abort as
 * "cancelled", a timeout as "timeout", a network failure as "unavailable";
 * an error with an HTTP status by that status; anything else "unavailable",
 * the original kept as the cause.
 */
export function normalizeError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e;
  const marked = (e as { providerKind?: unknown } | null)?.providerKind;
  if (marked === "readOnly") return new ProviderError("readOnly", e instanceof Error ? e.message : "Read-only", { cause: e });
  if (signal?.aborted) return new ProviderError("cancelled", "Cancelled", { cause: e });
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError") return new ProviderError("timeout", "No answer in time", { cause: e });
  if (name === "AbortError") return new ProviderError("cancelled", "Cancelled", { cause: e });
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number") return new ProviderError(kindOfStatus(status), e instanceof Error ? e.message : `HTTP ${status}`, { status, cause: e });
  // A TypeError that isn't the network failing is a bug: said, never queued as "offline".
  if (e instanceof TypeError && !unreachable(e)) return new ProviderError("invalid", `Internal error: ${e.message}`, { cause: e });
  return new ProviderError("unavailable", e instanceof Error ? e.message : String(e), { cause: e });
}

const NETWORK_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_\w+)$/;

/** undici's way of saying the service couldn't be reached: TypeError("fetch failed"), the socket error as cause. */
function unreachable(e: TypeError): boolean {
  if (e.message === "fetch failed") return true;
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && NETWORK_CODES.test(code);
}
