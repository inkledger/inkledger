// This server's identity for module licences (WP-19): an Ed25519 key made on
// first need, kept in a file of its own (INSTANCE_KEY_PATH, 0600, created
// exclusively: two processes never make two), never in the database, so a
// copied database is not a copied server. Its id is what the store counts.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";

export type Instance = {
  /** First 16 bytes of sha256(raw public key), hex */
  id: string;
  /** The raw 32-byte public key, base64url */
  pubkey: string;
  /** Signs the store's proof of possession */
  sign(message: string): string;
};

const b64url = (b: Buffer) => b.toString("base64url");

function loadOrMake(file: string): KeyObject {
  try {
    return createPrivateKey(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  try {
    // "wx": only if it doesn't exist yet; another process that won the race keeps its key.
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, pem);
    } finally {
      closeSync(fd);
    }
    return privateKey;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return createPrivateKey(readFileSync(file, "utf8"));
    throw e;
  }
}

let cached: { file: string; instance: Instance } | null = null;

/** This server's instance (its key made on first call). */
export function instance(file = env.instanceKeyPath): Instance {
  if (cached?.file === file) return cached.instance;
  const key = loadOrMake(file);
  // The raw key is the SPKI's last 32 bytes (Ed25519).
  const raw = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
  const made: Instance = {
    id: createHash("sha256").update(raw).digest("hex").slice(0, 32),
    pubkey: b64url(Buffer.from(raw)),
    sign: (message) => b64url(sign(null, Buffer.from(message, "utf8"), key)),
  };
  cached = { file, instance: made };
  return made;
}

/** What the store's proof of possession signs. */
export const proofMessage = (action: "activate" | "deactivate", nonce: string, instanceId: string, licenseId: string) =>
  `inkledger-activate-v1\n${action}\n${nonce}\n${instanceId}\n${licenseId}`;
