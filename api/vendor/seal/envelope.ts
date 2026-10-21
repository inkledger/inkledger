// A signed envelope (licence keys): base64url(payload) + "." + base64url(signature).
// The signature is Ed25519 over `context` followed by the payload bytes as
// encoded (not re-serialized JSON). The context keeps licences and packages of
// one key, and different apps, apart. The payload's meaning is the caller's:
// it is read only after the signature holds.

import { sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { fromBase64url, toBase64url } from "./base64url.ts";
import { verifyWithAny } from "./keys.ts";
import type { PublicKeyInput } from "./keys.ts";

export const envelopeBytes = (payload: Uint8Array, context: string): Buffer =>
  Buffer.concat([Buffer.from(context, "utf8"), payload]);

export type EnvelopeResult =
  | { ok: true; payload: Buffer; keyIndex: number }
  | { ok: false; reason: "malformed"; detail: string }
  | { ok: false; reason: "no-key"; detail: string }
  | { ok: false; reason: "bad-signature" };

export function verifyEnvelope(text: string, opts: { context: string; keys: readonly PublicKeyInput[] }): EnvelopeResult {
  const parts = typeof text === "string" ? text.trim().split(".") : [];
  const [p0, p1] = parts;
  if (parts.length !== 2 || p0 === undefined || p1 === undefined) return { ok: false, reason: "malformed", detail: "expected two parts separated by a dot" };
  const payload = fromBase64url(p0);
  const signature = fromBase64url(p1);
  if (payload === null) return { ok: false, reason: "malformed", detail: "payload is not base64url" };
  if (signature === null) return { ok: false, reason: "malformed", detail: "signature is not base64url" };
  const v = verifyWithAny(envelopeBytes(payload, opts.context), signature, opts.keys);
  if (!v.ok) return v;
  return { ok: true, payload, keyIndex: v.keyIndex };
}

/** Publisher side (CLI): the envelope text for `payload`. */
export function signEnvelope(payload: Uint8Array, context: string, privateKey: KeyObject): string {
  return `${toBase64url(payload)}.${toBase64url(sign(null, envelopeBytes(payload, context), privateKey))}`;
}
