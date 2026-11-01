export const WORKSPACE_SCHEMA_VERSION = 1;
export const PATCH_SCHEMA_VERSION = 1;
export const LAYOUT_SCHEMA_VERSION = 1;
export const RESOLVER_VERSION = 1;
export const CANONICALIZATION_VERSION = 1;
export const FINGERPRINT_FIELDS_VERSION = 1;
export const FINGERPRINT_ALGORITHM = "SHA-256";
export const OPAQUE_ENTRY_VERSION = 1;

function releaseParts(value: string): readonly [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isWorkspaceVersion(value: string): boolean {
  return releaseParts(value) !== null;
}

export function compareWorkspaceVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = releaseParts(a);
  const right = releaseParts(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export const APPLY_POLICY_V1 = {
  version: 1,
  preparedTtlMs: 60_000,
  activationLeaseTtlMs: 15_000,
  pendingActivationTtlMs: 30_000,
  activationUncertainRetentionMs: 24 * 60 * 60 * 1000,
  tokenBytes: 32,
} as const;
