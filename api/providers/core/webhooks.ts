// Helpers for adapters checking webhook deliveries (TrackerProvider.webhook).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 of the body with the secret, hex: what GitHub-style "sha256=…" signatures carry. */
export const hmacHex = (secret: string, body: string | Uint8Array) => createHmac("sha256", secret).update(body).digest("hex");

/** Equal strings, in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Equal strings, in constant time, their lengths unsaid too (both hashed first): for a secret sent as is. */
export const sameSecretHashed = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

/** A delivery's headers, as a request gives them. */
export type DeliveryHeaders = Headers | Record<string, string | string[] | undefined>;

/** A header of a delivery, by its name in any case (the first value of a repeated one). */
export function headerOf(headers: DeliveryHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return Array.isArray(hit?.[1]) ? hit[1][0] : hit?.[1];
}

/** A "sha256=<hex>" signature header against the body and secret. */
export function verifySha256Header(header: string | undefined, secret: string, body: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return sameSecret(header.slice("sha256=".length).toLowerCase(), hmacHex(secret, body));
}
