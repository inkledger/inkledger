import { TRPCClientError } from "@trpc/client";
import { toast } from "sonner";
import { t } from "@/i18n";
import { APP_BUILD_CHANGED } from "@contracts/appBuild";

/**
 * An error written for the person using the app (already in their words): shown as it is.
 * Anything else thrown in the client is a fault, told in general words.
 */
export class UserFacingError extends Error {}

/** What kind of failure it is, as far as the person using the app is concerned. */
export type ErrorKind = "said" | "network" | "timeout" | "other";

// The browsers' own words for a request that never got an answer (Chrome, Safari, Firefox, React Native).
const NETWORK = /Failed to fetch|Load failed|NetworkError when attempting to fetch|Network request failed/i;

const named = (e: unknown, name: string) => typeof e === "object" && e !== null && (e as { name?: unknown }).name === name;

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export function errorKind(e: unknown): ErrorKind {
  if (e instanceof TRPCClientError) {
    // The server answered with its own error: its words are meant to be read (internal
    // faults already come back in general words, the details in its log). Save the signal
    // that a newer build is serving, which reloads the page: a code, not words; and an error
    // sent with no words of its own (its message is then its code, e.g. "NOT_FOUND").
    if (e.data) return e.message === APP_BUILD_CHANGED || e.message === (e.data as { code?: unknown }).code ? "other" : "said";
    // No answer of the server's: why the request failed, from what it carries.
    const cause = errorKind(e.cause);
    if (cause === "network" || cause === "timeout") return cause;
    return NETWORK.test(e.message) || offline() ? "network" : "other";
  }
  if (e instanceof UserFacingError) return "said";
  // A text thrown as it is: the native shell's (Tauri rejects an invoke with what its
  // command wrote, in the shell's language); nothing else in the client throws one.
  if (typeof e === "string" && e.trim() !== "") return "said";
  if (named(e, "TimeoutError")) return "timeout";
  if (e instanceof TypeError && NETWORK.test(e.message)) return "network";
  return offline() ? "network" : "other";
}

/**
 * The words to show for a failure: the server's or the app's own, else what kind of failure
 * it was (a fault's own text, often technical or in another language, never shows). Pure: safe
 * in a render; the details of a fault go to the console where it is reported (toastError, the
 * query cache).
 */
export function errorText(e: unknown): string {
  const kind = errorKind(e);
  if (kind === "said") return typeof e === "string" ? e : (e as Error).message;
  if (kind === "network") return t("ui.error.network");
  if (kind === "timeout") return t("ui.error.timeout");
  return t("ui.error.failed");
}

const logged = new WeakSet<object>();

/** A fault's details for the console (general words are what the person sees), once per error however many report it. */
export function logFault(e: unknown): void {
  if (errorKind(e) !== "other") return;
  if (typeof e === "object" && e !== null) {
    if (logged.has(e)) return;
    logged.add(e);
  }
  console.error(e);
}

/** A failure shown other than as a toast (in a form, inside a sentence): its words, a fault's details to the console. */
export function failureText(e: unknown): string {
  logFault(e);
  return errorText(e);
}

/**
 * A failure as a toast; a fault's details to the console. The same words twice at once show
 * once (a local and a shared handler both reporting it). In onError, call it with the error
 * alone: React Query passes the variables second.
 */
export function toastError(e: unknown, opts?: { duration?: number; action?: { label: string; onClick: () => void } }): void {
  logFault(e);
  const text = errorText(e);
  toast.error(text, { id: `error:${text}`, ...opts });
}
