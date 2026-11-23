import { createHmac } from "node:crypto";
import { RUN_TOKEN_MS } from "@contracts/modules";
import { env } from "../lib/env";
import { sameSecret } from "../lib/secrets";

/**
 * Code tokens for framed modules: an opaque frame sends no cookie, so its
 * module's files come from a URL saying who asked, for which package, until
 * when. Bound to the account, the module and its package hash.
 */
const key = () => createHmac("sha256", env.sessionSecret).update("inkledger-module-run-v1").digest();
const mac = (userId: number, id: string, hash: string, exp: number) =>
  createHmac("sha256", key()).update(`${userId}\n${id}\n${hash}\n${exp}`).digest("base64url");

/** Tokens change once a slot: frames opened within one share the code's URLs, so the browser's copy serves them. */
const SLOT_MS = 15 * 60_000;

export function runToken(userId: number, id: string, hash: string, now = Date.now()): string {
  // Ends on a slot's edge: it holds between RUN_TOKEN_MS - SLOT_MS and RUN_TOKEN_MS.
  const exp = (Math.floor((now + RUN_TOKEN_MS) / SLOT_MS) * SLOT_MS) / 1000;
  return `${userId}.${exp}.${mac(userId, id, hash, exp)}`;
}

/** The account a token was made for, while it holds for this module and package; else null. */
export function runTokenUser(token: string, id: string, hash: string, now = Date.now()): number | null {
  const m = /^([1-9]\d{0,9})\.([1-9]\d{0,11})\.([\w-]{43})$/.exec(token);
  if (!m) return null;
  const userId = Number(m[1]);
  const exp = Number(m[2]);
  if (exp * 1000 <= now) return null;
  return sameSecret(mac(userId, id, hash, exp), m[3]) ? userId : null;
}
