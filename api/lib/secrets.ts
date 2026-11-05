import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 of the body with the secret, hex: what GitHub-style "sha256=…" signatures carry. */
export const hmacHex = (secret: string, body: string | Uint8Array) => createHmac("sha256", secret).update(body).digest("hex");

/** Equal strings, in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
