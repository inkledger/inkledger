// Helpers for adapters checking webhook deliveries (TrackerProvider.webhook).
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 of the body with the secret, hex: what GitHub-style "sha256=…" signatures carry. */
export const hmacHex = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

/** Equal strings, in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A "sha256=<hex>" signature header against the body and secret. */
export function verifySha256Header(header: string | undefined, secret: string, body: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return sameSecret(header.slice("sha256=".length).toLowerCase(), hmacHex(secret, body));
}
