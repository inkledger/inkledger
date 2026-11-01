import { createHash } from "node:crypto";
import { hexOf } from "@contracts/workspace/canonical";
import { fingerprintDescriptor, fingerprintInput, type FingerprintKind } from "@contracts/workspace/fingerprint";
import type { FingerprintDescriptor } from "@contracts/workspace/model";
import { base64UrlToBytes, opaqueEntryFromBytes, type OpaqueEntry } from "@contracts/workspace/opaque";

export function digestBytes(bytes: Uint8Array): string {
  return hexOf(createHash("sha256").update(bytes).digest());
}

export function fingerprint(kind: FingerprintKind, value: unknown): FingerprintDescriptor {
  return fingerprintDescriptor(digestBytes(fingerprintInput(kind, value)));
}

export function createOpaqueEntry(entryType: string, schemaVersion: number, bytes: Uint8Array): OpaqueEntry {
  return opaqueEntryFromBytes(entryType, schemaVersion, bytes, digestBytes(bytes));
}

export function verifyOpaqueEntry(entry: OpaqueEntry): boolean {
  return digestBytes(base64UrlToBytes(entry.payloadBase64url)) === entry.sha256;
}
