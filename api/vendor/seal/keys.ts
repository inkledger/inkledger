// Publisher keys: Ed25519 only. No key (null or "") means nothing verifies:
// apps ship with no key until the publisher generates one (fail closed).

import { createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

export type PublicKeyInput = KeyObject | string | null;
export type KeyResult = { ok: true; key: KeyObject } | { ok: false; reason: string };

export function loadPublicKey(input: PublicKeyInput): KeyResult {
  if (input === null || input === "") return { ok: false, reason: "no publisher public key" };
  try {
    const k = typeof input === "string" ? createPublicKey(input) : input;
    if (k.type !== "public") return { ok: false, reason: "the publisher key is not public" };
    if (k.asymmetricKeyType !== "ed25519") return { ok: false, reason: `the publisher key is not ed25519 (${k.asymmetricKeyType ?? "?"})` };
    return { ok: true, key: k };
  } catch (e) {
    return { ok: false, reason: `unreadable publisher key: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Ed25519 over data; any node:crypto error counts as a bad signature. */
export function signatureValid(data: Uint8Array, signature: Uint8Array, key: KeyObject): boolean {
  if (signature.length !== 64) return false;
  try {
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

/**
 * The first of `keys` that verifies (several are trusted while a key rotates).
 * No usable key at all: "no-key", with the first reason.
 */
export function verifyWithAny(
  data: Uint8Array,
  signature: Uint8Array,
  keys: readonly PublicKeyInput[]
): { ok: true; keyIndex: number } | { ok: false; reason: "no-key"; detail: string } | { ok: false; reason: "bad-signature" } {
  const loaded = keys.map(loadPublicKey);
  const usable = loaded.flatMap((k, i) => (k.ok ? [{ key: k.key, i }] : []));
  if (usable.length === 0) {
    const first = loaded.find((k): k is { ok: false; reason: string } => !k.ok);
    return { ok: false, reason: "no-key", detail: first?.reason ?? "no publisher public key" };
  }
  const hit = usable.find(({ key }) => signatureValid(data, signature, key));
  return hit ? { ok: true, keyIndex: hit.i } : { ok: false, reason: "bad-signature" };
}
