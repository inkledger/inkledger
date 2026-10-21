import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { env } from "./env";

function key(): Buffer {
  return createHash("sha256").update(env.sessionSecret).digest();
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM encryption with the session-derived key (older secrets; tracker credentials use sealSecret). */
export function encrypt(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: TAG_BYTES });
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(
    ".",
  );
}

export function decrypt(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted payload");
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  // A short tag would weaken GCM authentication: insist on the full 16 bytes.
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------- Tracker credentials (T7) ----------
// Sealed with CREDENTIALS_KEY and bound to their connection (the AAD): a
// secret copied onto another connection doesn't open. "v1." heads the
// format, so a future one can be told apart.

const SEALED = "v1.";

function keyFrom(secret: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(secret) ? Buffer.from(secret, "hex") : createHash("sha256").update(secret).digest();
}

/** The key sealing now, then the ones that may still open older secrets. */
function credentialKeys(): Buffer[] {
  const current = env.credentialsKey ? keyFrom(env.credentialsKey) : key();
  const older = [...(env.credentialsKeyOld ? [keyFrom(env.credentialsKeyOld)] : []), key()];
  return [current, ...older.filter((k) => !k.equals(current))];
}

const aadOf = (connectionId: number) => Buffer.from(`connection:${connectionId}`, "utf8");

/** A connection's secret, sealed for that connection with the current key. */
export function sealSecret(plain: string, connectionId: number): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", credentialKeys()[0], iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(connectionId));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return SEALED + [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

function openWith(key: Buffer, parts: string[], aad: Buffer | null): string {
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, "base64"));
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * A connection's secret in clear: sealed for it (any known key), or in the
 * older format (no binding, derived from SESSION_SECRET). `fresh` says
 * whether it is already sealed with the current key for this connection.
 */
export function openSecret(payload: string, connectionId: number): { plain: string; fresh: boolean } {
  const sealed = payload.startsWith(SEALED);
  const parts = (sealed ? payload.slice(SEALED.length) : payload).split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted payload");
  const keys = credentialKeys();
  for (const [i, key] of keys.entries()) {
    try {
      return { plain: openWith(key, parts, sealed ? aadOf(connectionId) : null), fresh: sealed && i === 0 };
    } catch {
      // the next key, if any
    }
  }
  throw new Error("Credentials can't be opened with the configured keys");
}

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}
