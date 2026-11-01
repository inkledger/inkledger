import { OPAQUE_ENTRY_VERSION } from "./versions";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_ENTRIES = 32;
const MAX_TOTAL_BYTES = 128 * 1024;

export type OpaqueEntry = {
  version: typeof OPAQUE_ENTRY_VERSION;
  entryType: string;
  schemaVersion: number;
  payloadBase64url: string;
  sha256: string;
  byteLength: number;
};

export type OpaqueDocument<T> = {
  known: T;
  opaque: readonly OpaqueEntry[];
  unknownContent: boolean;
};

export function bytesToBase64Url(bytes: Uint8Array): string {
  let output = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += ALPHABET[(accumulator >>> bits) & 63];
    }
  }
  if (bits > 0) output += ALPHABET[(accumulator << (6 - bits)) & 63];
  return output;
}

export function base64UrlToBytes(payload: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(payload) || payload.length % 4 === 1) {
    throw new Error("opaque v1: invalid base64url payload");
  }
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of payload) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) throw new Error("opaque v1: invalid base64url character");
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 255);
    }
  }
  return Uint8Array.from(output);
}

export function assertOpaqueEntries(entries: readonly OpaqueEntry[]): void {
  if (entries.length > MAX_ENTRIES) throw new Error("opaque v1: too many entries");
  let total = 0;
  const identities = new Set<string>();
  for (const entry of entries) {
    if (entry.version !== OPAQUE_ENTRY_VERSION) throw new Error("opaque v1: unsupported entry version");
    if (!entry.entryType || !Number.isSafeInteger(entry.schemaVersion) || entry.schemaVersion < 1) {
      throw new Error("opaque v1: invalid type or schema version");
    }
    const identity = `${entry.entryType}@${entry.schemaVersion}`;
    if (identities.has(identity)) throw new Error(`opaque v1: duplicate entry ${identity}`);
    identities.add(identity);
    const bytes = base64UrlToBytes(entry.payloadBase64url);
    if (bytes.length !== entry.byteLength) throw new Error("opaque v1: byte length mismatch");
    if (bytes.length > MAX_ENTRY_BYTES) throw new Error("opaque v1: entry too large");
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("opaque v1: invalid digest");
    total += bytes.length;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("opaque v1: document too large");
}

export function opaqueEntryFromBytes(
  entryType: string,
  schemaVersion: number,
  bytes: Uint8Array,
  sha256: string,
): OpaqueEntry {
  const entry: OpaqueEntry = {
    version: OPAQUE_ENTRY_VERSION,
    entryType,
    schemaVersion,
    payloadBase64url: bytesToBase64Url(bytes),
    sha256,
    byteLength: bytes.length,
  };
  assertOpaqueEntries([entry]);
  return entry;
}

export function opaqueDocument<T>(known: T, opaque: readonly OpaqueEntry[]): OpaqueDocument<T> {
  assertOpaqueEntries(opaque);
  return { known, opaque, unknownContent: opaque.length > 0 };
}

export function assertWritableDocument(document: OpaqueDocument<unknown>): void {
  if (document.unknownContent) throw new Error("opaque v1: unknown content is read-only");
}
