import { describe, expect, it } from "vitest";
import { fakeTracker } from "../fake/adapter";
import { providerProblems } from "./validate";

describe("provider contract", () => {
  it("status history is declared with its method", () => {
    const base = fakeTracker();
    const declaredOnly = { ...base, capabilities: { ...base.capabilities, statusHistory: true } };
    expect(providerProblems(declaredOnly)).toContain("statusHistory is declared but not implemented");
    const implementedOnly = { ...base, statusHistory: async () => [] };
    expect(providerProblems(implementedOnly)).toContain("statusHistory is implemented but not declared");
    expect(providerProblems({ ...implementedOnly, capabilities: declaredOnly.capabilities })).toEqual([]);
  });
});
