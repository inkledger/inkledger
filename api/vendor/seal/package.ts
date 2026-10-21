// A signed package: a folder with a manifest (whose schema is the app's, with a
// map path → sha256 of every file) and a detached signature over `context`
// followed by the manifest's canonical JSON.
//
// In doubt, deny: every file of the folder must be declared with its hash and
// every declared file must be there; a path leaving the folder (.., absolute, a
// symbolic link) makes the package invalid. Nothing throws from here.

import { createHash, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fromBase64url, toBase64url } from "./base64url.ts";
import { canonicalBytes } from "./canonical.ts";
import { verifyWithAny } from "./keys.ts";
import type { PublicKeyInput } from "./keys.ts";

/** An id that can be a folder name: no separators, no leading dot. */
export const validId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);

/**
 * A relative path that stays inside: "/" separators, not absolute, no "..", "."
 * or empty segments, no backslashes or NUL, NFC only (the signed canonical form
 * normalizes keys: an NFD name would pass with its NFC twin's signature).
 * `reserved` (the manifest and signature files) are never declared.
 */
export function pathInside(p: string, reserved: readonly string[] = []): boolean {
  if (p === "" || p !== p.normalize("NFC") || p.includes("\\") || p.includes("\0") || posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false;
  if (reserved.includes(p)) return false;
  return p.split("/").every(s => s !== "" && s !== "." && s !== "..");
}

export const sha256hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * The SHA-256 of every file under `dir`, by relative "/" path. A symbolic link or
 * special file is not followed: it lands with a path pathInside rejects
 * ("../link"). If `dir` itself is a link, the map is just "..".
 */
export function hashDirectory(dir: string): Record<string, string> {
  if (!lstatSync(dir).isDirectory()) return { "..": "" };
  const walk = (rel: string): [string, string][] =>
    readdirSync(rel === "" ? dir : join(dir, rel)).flatMap((name): [string, string][] => {
      const p = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(join(dir, p));
      if (st.isDirectory()) return walk(p);
      if (!st.isFile()) return [[`../${p}`, ""]];
      return [[p, sha256hex(readFileSync(join(dir, p)))]];
    });
  return Object.fromEntries(walk(""));
}

export type PackageResult =
  | { ok: true; keyIndex: number }
  | { ok: false; reason: "no-key"; detail: string }
  | { ok: false; reason: "bad-signature" }
  | { ok: false; reason: "outside" | "missing" | "extra" | "mismatch"; path: string };

/**
 * The pure check, in order: declared paths, key, signature, then the computed
 * hashes (missing, extra, different). Schema validation of `manifest` is the
 * caller's, done before; `declared` is its path → sha256 map.
 */
export function verifyPackage(arg: {
  manifest: unknown;
  declared: Record<string, string>;
  signature: string | Uint8Array;
  computed: Record<string, string>;
  context: string;
  keys: readonly PublicKeyInput[];
  reserved: readonly string[];
}): PackageResult {
  const declaredPaths = Object.keys(arg.declared);
  const outside = declaredPaths.find(p => !pathInside(p, arg.reserved));
  if (outside !== undefined) return { ok: false, reason: "outside", path: outside };
  const signature = typeof arg.signature === "string" ? fromBase64url(arg.signature.trim()) : arg.signature;
  const data = canonicalBytes(arg.manifest, arg.context);
  // An unreadable signature or manifest still reports a missing key first.
  const v = verifyWithAny(data ?? Buffer.alloc(0), signature ?? Buffer.alloc(0), arg.keys);
  if (!v.ok) return v;
  const computedPaths = Object.keys(arg.computed);
  const outsideComputed = computedPaths.find(p => !pathInside(p, arg.reserved) && !arg.reserved.includes(p));
  if (outsideComputed !== undefined) return { ok: false, reason: "outside", path: outsideComputed };
  const missing = declaredPaths.find(p => !Object.hasOwn(arg.computed, p));
  if (missing !== undefined) return { ok: false, reason: "missing", path: missing };
  const extra = computedPaths.find(p => !arg.reserved.includes(p) && !Object.hasOwn(arg.declared, p));
  if (extra !== undefined) return { ok: false, reason: "extra", path: extra };
  const mismatch = declaredPaths.find(p => arg.declared[p] !== arg.computed[p]);
  if (mismatch !== undefined) return { ok: false, reason: "mismatch", path: mismatch };
  return { ok: true, keyIndex: v.keyIndex };
}

/** Publisher side (CLI): the detached signature of a manifest, base64url. Null if not canonical. */
export function signManifest(manifest: unknown, context: string, privateKey: KeyObject): string | null {
  const data = canonicalBytes(manifest, context);
  return data === null ? null : toBase64url(sign(null, data, privateKey));
}
