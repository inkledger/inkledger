import { describe, expect, it } from "vitest";
import { loggedPath } from "../lib/requestLog";
import { fingerprint } from "./crypto";
import { assertNoOriginalText, fingerprintablePatch } from "@contracts/workspace/privacy";
import type { SuggestionPatch } from "@contracts/workspace/model";

const patch: SuggestionPatch = {
  patchId: "patch-private",
  patchSchemaVersion: 1,
  scope: { surfaceId: "dashboard", deviceClass: "desktop" },
  baseRevision: "rev-1",
  catalogVersion: "catalog-1",
  author: "user",
  provenance: {},
  intent: { kind: "prioritize", status: "explicit", anchorId: "timer" },
  operations: [],
  evidence: [],
  proposedConstraints: [],
};

describe("private intent text", () => {
  it("keeps originalText out of persistent documents and fingerprint input", () => {
    const withText = { ...patch, originalText: "private workflow request" } as SuggestionPatch & { originalText?: string };
    expect(() => assertNoOriginalText(withText)).toThrow("originalText is transient");
    expect(() => assertNoOriginalText(patch)).not.toThrow();
    const safe = fingerprintablePatch(withText);
    expect("originalText" in safe).toBe(false);
    expect(fingerprint("input", safe)).toEqual(fingerprint("input", fingerprintablePatch(patch)));
  });

  it("rejects private text nested in imported constraints instead of fingerprinting it", () => {
    const nested = {
      ...patch,
      proposedConstraints: [{
        id: "constraint-private",
        kind: "pin",
        status: "proposed",
        author: "import",
        scope: patch.scope,
        anchorId: "timer",
        originalText: "nested private request",
      }],
    } as unknown as SuggestionPatch;
    expect(() => fingerprintablePatch(nested)).toThrow("originalText is transient");
  });

  it("never logs query input or private path tokens", () => {
    const path = loggedPath("https://app.test/api/trpc/workspace.apply?input=private-workflow-request");
    expect(path).toBe("/api/trpc/workspace.apply");
    expect(path).not.toContain("private-workflow-request");
    expect(loggedPath("https://app.test/api/shared/private-token")).toBe("/api/shared/…");
  });
});
