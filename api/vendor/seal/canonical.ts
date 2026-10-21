// Canonical JSON (v1): sorted keys, NFC strings, no spaces, safe integers only.
// What gets signed does not depend on how a file is indented. Ported unchanged
// from agent-peer-bridge (src/memoria.ts), whose signatures must keep verifying.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws on floats, unsafe integers and non-JSON types; canonicalBytes wraps it. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("canon v1: no floats");
    // Beyond safe: String(1e21) is "1e+21" (not canonical JSON).
    if (!Number.isSafeInteger(v)) throw new Error("canon v1: integer beyond Number.MAX_SAFE_INTEGER");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v.normalize("NFC"));
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(",")}]`; // order is meaning: never sorted
  if (isRecord(v)) {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k.normalize("NFC"))}:${canonicalJSON(v[k])}`).join(",")}}`;
  }
  throw new Error(`canon v1: type not allowed (${typeof v})`);
}

/** `context` then the canonical JSON of `v`, as UTF-8; null when `v` has no canonical form. */
export function canonicalBytes(v: unknown, context: string): Buffer | null {
  try {
    return Buffer.from(context + canonicalJSON(v), "utf8");
  } catch {
    return null;
  }
}
