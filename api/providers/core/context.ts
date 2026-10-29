// The call under way, for code that runs inside an adapter call without
// receiving its context (the shared HTTP layer): the binding runs every
// adapter call inside one, so cancellation and the correlation id reach each
// request without threading them through every client function.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Credential } from "../types";

export type CallMeta = { signal: AbortSignal; correlationId: string };

/** A call under way: its meta, and whether its connection may write (an unverified adapter, writes not allowed yet). */
type Running = CallMeta & { readOnly?: boolean };

const current = new AsyncLocalStorage<Running>();

/** Runs `fn` as part of the call `meta` (read-only when its connection may not write). */
export const inCall = <R>(meta: CallMeta, fn: () => R, readOnly = false): R => current.run({ ...meta, readOnly }, fn);

/** The call under way, if any. */
export const currentCall = (): Running | undefined => current.getStore();

/** A request's own signal combined with the call's (whichever aborts first). */
export function callSignal(own: AbortSignal | null | undefined): AbortSignal | undefined {
  const call = currentCall()?.signal;
  if (call && own) return AbortSignal.any([own, call]);
  return call ?? own ?? undefined;
}

/** The secret a credential carries, whatever its kind: a token, an OAuth access token or a password. */
export const secretOf = (cred: Credential): string => (cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password);
