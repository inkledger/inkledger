import { describe, it, expect } from "vitest";
import { branchName, byRelevance, commitMessage, relevanceText } from "./issues";

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

  it("never ends on a one-letter or linking word (a name that reads as cut)", () => {
    expect(branchName("MAGA-399", "Creazione inventario da app magazziniere v.2 e altro")).toBe(
      "feature/MAGA-399-creazione-inventario-da-app-magazziniere"
    );
    expect(branchName("MAGA-12", "Export of the orders for the")).toBe("feature/MAGA-12-export-of-the-orders");
    expect(branchName("MAGA-13", "Import step 2")).toBe("feature/MAGA-13-import-step-2");
  });

  it("stays within the length, cut at a word", () => {
    const name = branchName("MAGA-7", "Riconciliazione automatica movimentazioni magazzino internazionale straordinaria");
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).toBe("feature/MAGA-7-riconciliazione-automatica-movimentazioni");
  });

  it("a bug is a bugfix branch, in the tracker's language too", () => {
    expect(branchName("MAGA-5", "Crash on save", { issueType: "Bug" })).toBe("bugfix/MAGA-5-crash-on-save");
    expect(branchName("MAGA-6", "Errore al salvataggio", { issueType: "Errore" })).toBe("bugfix/MAGA-6-errore-al-salvataggio");
    expect(branchName("MAGA-8", "Nuova vista", { issueType: "Attività" })).toBe("feature/MAGA-8-nuova-vista");
  });
});

describe("commitMessage", () => {
  it("starts with the key, as Jira links commits by it", () => {
    expect(commitMessage("MAGA-399", "  Creazione inventario\n da app ")).toBe("MAGA-399 Creazione inventario da app");
    expect(commitMessage("MAGA-1", "")).toBe("MAGA-1");
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
