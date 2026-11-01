import { domainSeparatedBytes } from "./canonical";
import type { FingerprintDescriptor } from "./model";
import {
  CANONICALIZATION_VERSION,
  FINGERPRINT_ALGORITHM,
  FINGERPRINT_FIELDS_VERSION,
} from "./versions";

export type FingerprintKind = "input" | "workspace" | "presentation" | "constraints" | "feedback" | "discovery" | "renderer-bindings";

export function fingerprintInput(kind: FingerprintKind, value: unknown): Uint8Array {
  return domainSeparatedBytes(`fingerprint-${kind}`, value);
}

export function fingerprintDescriptor(value: string): FingerprintDescriptor {
  return {
    canonicalizationVersion: CANONICALIZATION_VERSION,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    fieldsVersion: FINGERPRINT_FIELDS_VERSION,
    value,
  };
}
