// Strict base64url: url-safe alphabet only, no padding, and the round trip must
// give back the same text (no two encodings of the same bytes).

export function fromBase64url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.length > 0 && b.toString("base64url") === s ? b : null;
}

export const toBase64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
