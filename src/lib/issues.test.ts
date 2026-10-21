import { describe, it, expect } from "vitest";
import { branchName, byRelevance, relevanceText } from "./issues";

describe("branchName", () => {
  it("builds a short ASCII slug after the key", () => {
    expect(
      branchName(
        "DEMO-22744",
        "issue error 500 spain BUT ALSO THE REST OF THE WORLD"
      )
    ).toBe("feature/DEMO-22744-issue-error-500-spain-but-also");
    expect(branchName("MAGA-1", "Why is the café quality higher?")).toBe(
      "feature/MAGA-1-why-is-the-cafe-quality-higher"
    );
    expect(
      branchName("REST-9", "REST (Pet-IT)(/AppVenditore/Pet/save) >>>>")
    ).toBe("feature/REST-9-rest-pet-it-appvenditore-pet-save");
    expect(branchName("X-1", "!!!")).toBe("feature/X-1");
  });
});

describe("byRelevance", () => {
  it("orders by the most relevant moment, unknown last", () => {
    const rows = [
      { key: "A", relevantAt: 1000 },
      { key: "B", relevantAt: null },
      { key: "C", relevantAt: 5000 },
    ];
    expect([...rows].sort(byRelevance).map(r => r.key)).toEqual(["C", "A", "B"]);
  });

  it("speaks in minutes, hours, then days", () => {
    const now = new Date(2026, 9, 16, 15).getTime();
    expect(relevanceText(now - 30_000, now)).toBe("just now");
    expect(relevanceText(now - 20 * 60_000, now)).toBe("20 minutes ago");
    expect(relevanceText(now - 3 * 3600_000, now)).toBe("3 hours ago");
  });
});
