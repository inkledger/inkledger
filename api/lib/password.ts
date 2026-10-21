// Password hashing for inkledger's own accounts: scrypt, its parameters stored with
// each hash so they can be raised later (docs/dev/spikes.md: N=2^15 costs
// ~70 ms and 32 MB). At most four hashes run at once, so a burst of sign-ins
// can't take the server's memory.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_BYTES = 32;
const MAX_CONCURRENT = 4;

let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  // maxmem: the ceiling for one call (128·N·r bytes needed), with room
  const maxmem = 2 * 128 * N * r;
  return slot(
    () =>
      new Promise((resolve, reject) =>
        scrypt(password.normalize("NFC"), salt, KEY_BYTES, { N, r, p, maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
      ),
  );
}

/** "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST.N, COST.r, COST.p);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True when the password matches the stored hash (constant-time compare; a malformed hash never matches). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 2 ** 20) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (expected.length !== KEY_BYTES) return false;
  const key = await derive(password, salt, N, r, p);
  return timingSafeEqual(key, expected);
}

/** A hash to compare against when the account doesn't exist, so a missing user costs the same time. */
let decoy: Promise<string> | undefined;
export const decoyHash = () => (decoy ??= hashPassword(randomBytes(16).toString("hex")));

/** A readable one-time password for resets: 16 characters, ~95 bits. */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
