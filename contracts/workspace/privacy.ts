import type { SuggestionPatch } from "./model";

export function assertNoOriginalText(value: unknown): void {
  JSON.stringify(value, (key, nested: unknown) => {
    if (key === "originalText") throw new Error("originalText is transient and cannot be persisted");
    return nested;
  });
}

export function fingerprintablePatch(patch: SuggestionPatch): SuggestionPatch {
  const safe: SuggestionPatch = {
    patchId: patch.patchId,
    patchSchemaVersion: patch.patchSchemaVersion,
    scope: patch.scope,
    baseRevision: patch.baseRevision,
    catalogVersion: patch.catalogVersion,
    author: patch.author,
    provenance: patch.provenance,
    intent: patch.intent,
    operations: patch.operations,
    evidence: patch.evidence,
    proposedConstraints: patch.proposedConstraints,
    ...(patch.expectedOutcome === undefined ? {} : { expectedOutcome: patch.expectedOutcome }),
    ...(patch.suggestionSignature === undefined ? {} : { suggestionSignature: patch.suggestionSignature }),
    ...(patch.causalParentRevision === undefined ? {} : { causalParentRevision: patch.causalParentRevision }),
  };
  assertNoOriginalText(safe);
  return safe;
}
