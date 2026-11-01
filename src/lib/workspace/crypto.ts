import { hexOf } from "@contracts/workspace/canonical";
import { fingerprintDescriptor, fingerprintInput, type FingerprintKind } from "@contracts/workspace/fingerprint";
import type { FingerprintDescriptor } from "@contracts/workspace/model";
import { base64UrlToBytes, opaqueEntryFromBytes, type OpaqueEntry } from "@contracts/workspace/opaque";

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  return hexOf(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy)));
}

export async function fingerprint(kind: FingerprintKind, value: unknown): Promise<FingerprintDescriptor> {
  return fingerprintDescriptor(await digestBytes(fingerprintInput(kind, value)));
}

export async function createOpaqueEntry(entryType: string, schemaVersion: number, bytes: Uint8Array): Promise<OpaqueEntry> {
  return opaqueEntryFromBytes(entryType, schemaVersion, bytes, await digestBytes(bytes));
}

export async function verifyOpaqueEntry(entry: OpaqueEntry): Promise<boolean> {
  return (await digestBytes(base64UrlToBytes(entry.payloadBase64url))) === entry.sha256;
}
