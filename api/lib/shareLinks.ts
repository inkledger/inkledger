// Links to one attachment that open without a session, for an agent the user
// hands an issue to (docs/work/ideas/issue-copy.md R-6.3–R-6.7). Stateless:
// signed, expiring within a day; the user's generation counter revokes them all.
import { createHmac, timingSafeEqual } from "node:crypto";
import { derivedKeys } from "./crypto";

export const SHARE_MAX_MS = 24 * 3_600_000;
const PURPOSE = "inkledger:share-link";

export type SharePayload = {
  v: 1;
  /** The user whose credentials fetch it */
  u: number;
  /** The connection it is on */
  c: number;
  /** The attachment's id there */
  a: string;
  iat: number;
  exp: number;
  /** The user's share-link generation when signed */
  g: number;
  /** The issue it is in, when the tracker finds files through their issue (GitHub) */
  k?: string;
};

const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest();

/** A token for one attachment; at most a day long. */
export function signShare(p: Omit<SharePayload, "v">): string {
  if (p.exp <= p.iat || p.exp - p.iat > SHARE_MAX_MS) throw new Error("A share link lasts at most a day");
  const payload = Buffer.from(JSON.stringify({ v: 1, ...p } satisfies SharePayload)).toString("base64url");
  return `${payload}.${mac(derivedKeys(PURPOSE)[0], payload).toString("base64url")}`;
}

const isPayload = (x: unknown): x is SharePayload => {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return p.v === 1 && [p.u, p.c, p.iat, p.exp, p.g].every((n) => Number.isSafeInteger(n)) && typeof p.a === "string" && p.a.length > 0 && (p.k === undefined || typeof p.k === "string");
};

/** What a token grants, when its signature holds and it is fresh and short; null otherwise. */
export function verifyShare(token: string, now: number): SharePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const given = Buffer.from(sig, "base64url");
  const signed = derivedKeys(PURPOSE).some((k) => {
    const want = mac(k, payload);
    return given.length === want.length && timingSafeEqual(given, want);
  });
  if (!signed) return null;
  let p: unknown;
  try {
    p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isPayload(p) || p.exp < now || p.exp - p.iat > SHARE_MAX_MS) return null;
  return p;
}
