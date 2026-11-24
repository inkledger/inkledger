// Off-site copies are encrypted here, before they leave the server: AES-256-GCM in
// chunks, with a key derived from BACKUP_KEY (an environment variable the operator
// keeps; never stored in the database, so a stolen dump bucket opens with nothing
// the server holds). BACKUP_KEY_OLD still opens copies made before a rotation.
//
// Format: "IKLB" | 0x01 | key id (8) | salt (16) | nonce prefix (7), then records of
// up to CHUNK bytes, each sealed with its own nonce (prefix | counter | last flag) and
// the header as AAD. A file cut short, records reordered or another file's header
// all fail to open: the last record says it is the last.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { Transform, type TransformCallback, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { t } from "@contracts/i18n";

const MAGIC = Buffer.from("IKLB", "ascii");
const VERSION = 1;
const KEY_ID_BYTES = 8;
const SALT_BYTES = 16;
const PREFIX_BYTES = 7;
const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + SALT_BYTES + PREFIX_BYTES;
/** Plain bytes per record (the last one may hold fewer, or none). */
export const CHUNK = 64 * 1024;

/** No BACKUP_KEY: nothing is uploaded rather than uploaded in clear. */
export class BackupKeyError extends Error {}

/** A key as given: 64 hex characters are the key itself, anything else is hashed into one. */
function material(secret: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(secret) ? Buffer.from(secret, "hex") : createHash("sha256").update(secret, "utf8").digest();
}

/** The key that encrypts (BACKUP_KEY), then the one that may still open older copies (BACKUP_KEY_OLD). */
export function backupKeys(e: Record<string, string | undefined> = process.env): Buffer[] {
  return [e.BACKUP_KEY, e.BACKUP_KEY_OLD].map((v) => (v ?? "").trim()).filter(Boolean).map(material);
}

export const backupKeySet = (e: Record<string, string | undefined> = process.env) => (e.BACKUP_KEY ?? "").trim() !== "";

/** The key new copies are encrypted with: BACKUP_KEY only (BACKUP_KEY_OLD only opens). */
export const currentBackupKey = (e: Record<string, string | undefined> = process.env): Buffer | undefined => (backupKeySet(e) ? material((e.BACKUP_KEY ?? "").trim()) : undefined);

/** Which key a copy was made with, without saying anything about the key. */
const keyId = (master: Buffer) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "inkledger-backup-id", KEY_ID_BYTES));
const fileKey = (master: Buffer, salt: Buffer) => Buffer.from(hkdfSync("sha256", master, salt, "inkledger-backup-v1", 32));

function nonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, PREFIX_BYTES);
  n[11] = last ? 1 : 0;
  return n;
}

/** Encrypts what flows through it with BACKUP_KEY (throws BackupKeyError without one). */
export function encryptStream(master: Buffer | undefined = currentBackupKey()): Transform {
  if (!master) throw new BackupKeyError(t("server.backup.noBackupKey"));
  const salt = randomBytes(SALT_BYTES);
  const prefix = randomBytes(PREFIX_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), keyId(master), salt, prefix]);
  const key = fileKey(master, salt);
  let counter = 0;
  let pending: Buffer = Buffer.alloc(0);
  const seal = (plain: Buffer, last: boolean) => {
    if (counter > 0xffffffff) throw new Error("backup too large to encrypt");
    const c = createCipheriv("aes-256-gcm", key, nonce(prefix, counter++, last), { authTagLength: TAG_BYTES });
    c.setAAD(header);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        if (!started) {
          started = true;
          this.push(header);
        }
        pending = Buffer.concat([pending, chunk]);
        // Strictly more than a record: the last one is sealed as the last, in flush.
        while (pending.length > CHUNK) {
          this.push(seal(pending.subarray(0, CHUNK), false));
          pending = pending.subarray(CHUNK);
        }
        done();
      } catch (e) {
        done(e as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!started) this.push(header);
        this.push(seal(pending, true));
        done();
      } catch (e) {
        done(e as Error);
      }
    },
  });
}

/** Opens what encryptStream made, with BACKUP_KEY or BACKUP_KEY_OLD; fails on anything altered or cut short. */
export function decryptStream(keys: Buffer[] = backupKeys()): Transform {
  let header: Buffer | null = null;
  let key: Buffer | null = null;
  let prefix: Buffer = Buffer.alloc(0);
  let counter = 0;
  let pending: Buffer = Buffer.alloc(0);
  const RECORD = CHUNK + TAG_BYTES;
  const open = (record: Buffer, last: boolean) => {
    if (!key || !header || record.length < TAG_BYTES) throw new Error(t("server.backup.copyDamaged"));
    const d = createDecipheriv("aes-256-gcm", key, nonce(prefix, counter++, last), { authTagLength: TAG_BYTES });
    d.setAAD(header);
    d.setAuthTag(record.subarray(record.length - TAG_BYTES));
    try {
      return Buffer.concat([d.update(record.subarray(0, record.length - TAG_BYTES)), d.final()]);
    } catch {
      // A record that doesn't authenticate: altered, reordered, or the last one missing.
      throw new Error(t("server.backup.copyDamaged"));
    }
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        pending = Buffer.concat([pending, chunk]);
        if (!header) {
          if (pending.length < HEADER_BYTES) return done();
          header = pending.subarray(0, HEADER_BYTES);
          pending = pending.subarray(HEADER_BYTES);
          if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) throw new Error(t("server.backup.copyNotOurs"));
          const id = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES);
          const salt = header.subarray(MAGIC.length + 1 + KEY_ID_BYTES, MAGIC.length + 1 + KEY_ID_BYTES + SALT_BYTES);
          prefix = header.subarray(HEADER_BYTES - PREFIX_BYTES);
          const master = keys.find((k) => keyId(k).equals(id));
          if (!master) throw new BackupKeyError(t("server.backup.copyWrongKey"));
          key = fileKey(master, salt);
        }
        // Strictly more than a record: the last one is opened as the last, in flush.
        while (pending.length > RECORD) {
          this.push(open(pending.subarray(0, RECORD), false));
          pending = pending.subarray(RECORD);
        }
        done();
      } catch (e) {
        done(e as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!header) throw new Error(t("server.backup.copyDamaged"));
        this.push(open(pending, true));
        done();
      } catch (e) {
        done(e as Error);
      }
    },
  });
}

/** What an upload needs to say about the bytes it sends (S3 checks them; Object Lock requires it). */
export type Digest = { size: number; sha256Hex: string; sha256Base64: string; md5Base64: string };

/** Counts and hashes what flows through, unchanged. */
function digestTap(): { tap: Transform; digest: () => Digest } {
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      sha.update(chunk);
      md5.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  return {
    tap,
    digest: () => {
      const s = sha.digest();
      return { size, sha256Hex: s.toString("hex"), sha256Base64: s.toString("base64"), md5Base64: md5.digest("base64") };
    },
  };
}

/** `src` encrypted into `dst` (readable by this server's user only), with the digest of what was written. */
export async function encryptFile(src: string, dst: string, master: Buffer | undefined = currentBackupKey()): Promise<Digest> {
  const cipher = encryptStream(master);
  const { tap, digest } = digestTap();
  fs.closeSync(fs.openSync(dst, "w", 0o600));
  await pipeline(fs.createReadStream(src), cipher, tap, fs.createWriteStream(dst, { mode: 0o600 }));
  return digest();
}

/**
 * A copy opened into `dst`: written beside it first and renamed only once the last
 * record has verified, so nothing half-checked is ever there to be restored.
 */
export async function decryptToFile(src: Readable, dst: string, keys: Buffer[] = backupKeys()): Promise<void> {
  const tmp = `${dst}.partial`;
  try {
    fs.closeSync(fs.openSync(tmp, "w", 0o600));
    await pipeline(src, decryptStream(keys), fs.createWriteStream(tmp, { mode: 0o600 }));
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
