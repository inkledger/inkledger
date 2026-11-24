import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
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

// ---------- Bytes sealed for one thing (copies of mails) ----------
// 0x01 | iv(12) | tag(16) | data, AES-256-GCM with the credential keys and
// `scope` as the AAD: bytes moved to another row don't open.

const BYTES_V1 = 1;

/** Bytes sealed for `scope` with the current key. */
export function sealBytesFor(plain: Buffer, scope: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", credentialKeys()[0], iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([BYTES_V1]), iv, cipher.getAuthTag(), data]);
}

/** The bytes sealed with sealBytesFor for the same scope (any known key); throws otherwise. */
export function openBytesFor(sealed: Buffer, scope: string): Buffer {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== BYTES_V1) throw new Error("Malformed sealed bytes");
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const data = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  for (const key of credentialKeys()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(scope, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      /* the next key */
    }
  }
  throw new Error("Sealed bytes don't open with any known key");
}

/**
 * Keys for signing (not sealing) something of `purpose`, derived from the
 * credential keys: the current one first, then those that may still verify.
 */
export function derivedKeys(purpose: string): Buffer[] {
  return credentialKeys().map((k) => Buffer.from(hkdfSync("sha256", k, Buffer.alloc(0), purpose, 32)));
}

const aadOf = (connectionId: number) => Buffer.from(`connection:${connectionId}`, "utf8");

function seal(plain: string, aad: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", credentialKeys()[0], iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return SEALED + [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

/** A connection's secret, sealed for that connection with the current key. */
export function sealSecret(plain: string, connectionId: number): string {
  return seal(plain, aadOf(connectionId));
}

/** Another secret (a mail sign-in), sealed for what it belongs to (`scope`, e.g. "mail:<userId>"). */
export function sealFor(plain: string, scope: string): string {
  return seal(plain, Buffer.from(scope, "utf8"));
}

/** A secret sealed with sealFor for the same scope, in clear (any known key). */
export function openFor(payload: string, scope: string): string {
  if (!payload.startsWith(SEALED)) throw new Error("Malformed encrypted payload");
  const parts = payload.slice(SEALED.length).split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted payload");
  for (const key of credentialKeys()) {
    try {
      return openWith(key, parts, Buffer.from(scope, "utf8"));
    } catch {
      // the next key, if any
    }
  }
  throw new Error("Credentials can't be opened with the configured keys");
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
  // The older format was sealed with sha256 of the old SESSION_SECRET, whatever it looks like:
  // CREDENTIALS_KEY_OLD given as that secret opens it (64 hex chars included, read raw for sealed ones).
  const legacy = !sealed && env.credentialsKeyOld ? [createHash("sha256").update(env.credentialsKeyOld).digest()] : [];
  const keys = [...credentialKeys(), ...legacy];
  for (const [i, key] of keys.entries()) {
    try {
      return { plain: openWith(key, parts, sealed ? aadOf(connectionId) : null), fresh: sealed && i === 0 };
    } catch {
      // the next key, if any
    }
  }
  throw new Error("Credentials can't be opened with the configured keys");
}

// ---------- Which key opens what (cli.ts keys-status / reseal) ----------

/** The environment variable a key comes from. */
export type KeyName = "CREDENTIALS_KEY" | "CREDENTIALS_KEY_OLD" | "SESSION_SECRET";

/** The key that opens a sealed value, and whether it is already sealed with the current key; null when none does. */
export type KeyCheck = { key: KeyName; fresh: boolean } | null;

/** The keys that may open a sealed value, by where they come from (the same set credentialKeys tries). */
function namedKeys(): NamedKey[] {
  const out: NamedKey[] = [];
  const add = (name: KeyName, k: Buffer) => {
    if (!out.some((o) => o.key.equals(k))) out.push({ name, key: k });
  };
  if (env.credentialsKey) add("CREDENTIALS_KEY", keyFrom(env.credentialsKey));
  if (env.credentialsKeyOld) add("CREDENTIALS_KEY_OLD", keyFrom(env.credentialsKeyOld));
  add("SESSION_SECRET", key());
  return out;
}

/** Where the key sealing new values comes from: CREDENTIALS_KEY, else SESSION_SECRET. */
export function sealingKeyName(): KeyName {
  return env.credentialsKey ? "CREDENTIALS_KEY" : "SESSION_SECRET";
}

type NamedKey = { name: KeyName; key: Buffer };

function firstOpening(attempts: NamedKey[], open: (k: Buffer) => unknown): NamedKey | null {
  for (const a of attempts) {
    try {
      open(a.key);
      return a;
    } catch {
      // the next key, if any
    }
  }
  return null;
}

const checked = (found: NamedKey | null, sealedFormat: boolean): KeyCheck =>
  found ? { key: found.name, fresh: sealedFormat && found.key.equals(credentialKeys()[0]) } : null;

/** Which key opens a connection's secret (openSecret: sealed for it, or the older unbound format). */
export function keyOfSecret(payload: string, connectionId: number): KeyCheck {
  const sealed = payload.startsWith(SEALED);
  const parts = (sealed ? payload.slice(SEALED.length) : payload).split(".");
  if (parts.length !== 3) return null;
  const legacy: NamedKey[] =
    !sealed && env.credentialsKeyOld ? [{ name: "CREDENTIALS_KEY_OLD", key: createHash("sha256").update(env.credentialsKeyOld).digest() }] : [];
  return checked(firstOpening([...namedKeys(), ...legacy], (k) => openWith(k, parts, sealed ? aadOf(connectionId) : null)), sealed);
}

/** Which key opens a value sealed with sealFor for `scope`. */
export function keyOfSealed(payload: string, scope: string): KeyCheck {
  if (!payload.startsWith(SEALED)) return null;
  const parts = payload.slice(SEALED.length).split(".");
  if (parts.length !== 3) return null;
  return checked(firstOpening(namedKeys(), (k) => openWith(k, parts, Buffer.from(scope, "utf8"))), true);
}

/** Which key opens bytes sealed with sealBytesFor for `scope`. */
export function keyOfBytes(sealed: Buffer, scope: string): KeyCheck {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== BYTES_V1) return null;
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const data = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  const found = firstOpening(namedKeys(), (k) => {
    const decipher = createDecipheriv("aes-256-gcm", k, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(scope, "utf8"));
    decipher.setAuthTag(tag);
    decipher.update(data);
    decipher.final();
  });
  return checked(found, true);
}

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}
