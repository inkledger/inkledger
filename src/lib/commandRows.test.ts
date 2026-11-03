import { describe, expect, it } from "vitest";
import { defaultFilter } from "cmdk";
import { filterSections, moveActive, type CommandSection } from "./commandRows";

const option = (id: string, search: string, extra: { keywords?: string[]; forceShow?: boolean } = {}) => ({ id, search, ...extra });
const ids = (sections: CommandSection[], query: string) =>
  filterSections(sections, query).rows.map(r => (r.kind === "heading" ? `#${r.section.id}` : r.option.id));

const catalog: CommandSection[] = [
  { id: "recent", heading: "Recent", options: [option("1:WEB-12", "web-12 checkout fails 1"), option("1:API-3", "api-3 rate limit 1")] },
  {
    id: "catalog",
    heading: "Catalog",
    options: [option("1:WEB-1", "web-1 login page 1"), option("1:WEB-120", "web-120 web checkout 1"), option("2:WEB-12", "web-12 twin on github 2")],
  },
];

describe("filterSections, as cmdk 1.1.1", () => {
  it("no query: every option in its order, a heading per section", () => {
    expect(ids(catalog, "")).toEqual(["#recent", "1:WEB-12", "1:API-3", "#catalog", "1:WEB-1", "1:WEB-120", "2:WEB-12"]);
  });

  it("ranks with cmdk's own filter, inside each section; sections keep their order", () => {
    const shown = ids(catalog, "checkout");
    expect(shown).toEqual(["#recent", "1:WEB-12", "#catalog", "1:WEB-120"]);
    // The same scores cmdk gives (its filter, the option's text trimmed).
    expect(defaultFilter("web-120 web checkout 1", "checkout")).toBeGreaterThan(0);
    expect(defaultFilter("web-1 login page 1", "checkout")).toBe(0);
  });

  it("case, dashes and spaces as cmdk: 'web 12' finds WEB-12, best match first", () => {
    const rows = filterSections(catalog, "web 12").rows.filter(r => r.kind === "option").map(r => (r.kind === "option" ? r.option.id : ""));
    expect(rows[0]).toBe("1:WEB-12");
    expect(rows).toContain("2:WEB-12");
  });

  it("keywords are searched too (a shortcut shown beside a label)", () => {
    const nav: CommandSection[] = [{ id: "nav", options: [option("notes", "Notes", { keywords: ["G N"] }), option("board", "Board")] }];
    expect(ids(nav, "g n")).toEqual(["notes"]);
  });

  it("forceShow is always shown and not counted for No results; empty sections go with their heading", () => {
    const sections: CommandSection[] = [
      { id: "import", heading: "From Jira", options: [option("import", "import XYZ-9", { forceShow: true })] },
      ...catalog,
    ];
    const f = filterSections(sections, "zzzz");
    expect(f.rows.map(r => (r.kind === "heading" ? `#${r.section.id}` : r.option.id))).toEqual(["#import", "import"]);
    expect([f.options, f.counted]).toEqual([1, 0]);
  });

  it("two options with the same text stay two (by id)", () => {
    const twins: CommandSection[] = [{ id: "s", options: [option("1:DEMO-101", "DEMO-101 Test task number 1"), option("2:DEMO-101", "DEMO-101 Test task number 1")] }];
    expect(ids(twins, "DEMO-101 Test task number 1")).toEqual(["1:DEMO-101", "2:DEMO-101"]);
  });

  it("row and section of each option", () => {
    const f = filterSections(catalog, "");
    expect(f.rowOf).toEqual([1, 2, 4, 5, 6]);
    expect(f.sectionOf).toEqual([0, 0, 1, 1, 1]);
  });
});

describe("moveActive", () => {
  const list = filterSections(catalog, "");
  it("next and previous never wrap; nothing active: down takes the first, up nothing", () => {
    expect(moveActive(-1, "next", list)).toBe(0);
    expect(moveActive(-1, "prev", list)).toBe(-1);
    expect(moveActive(4, "next", list)).toBe(4);
    expect(moveActive(0, "prev", list)).toBe(0);
    expect(moveActive(2, "prev", list)).toBe(1);
  });

  it("first, last and pages", () => {
    expect(moveActive(2, "first", list)).toBe(0);
    expect(moveActive(0, "last", list)).toBe(4);
    expect(moveActive(0, "pageDown", list, 3)).toBe(3);
    expect(moveActive(4, "pageUp", list, 3)).toBe(1);
    expect(moveActive(3, "pageDown", list, 3)).toBe(4);
  });

  it("sections: the first option of the next, or of the previous (even going back)", () => {
    expect(moveActive(0, "nextSection", list)).toBe(2);
    expect(moveActive(3, "prevSection", list)).toBe(0);
    // No section after: a plain step; none before: a plain step back.
    expect(moveActive(3, "nextSection", list)).toBe(4);
    expect(moveActive(1, "prevSection", list)).toBe(0);
  });

  it("an empty list has nothing active", () => {
    expect(moveActive(0, "next", filterSections(catalog, "zzzz"))).toBe(-1);
  });
});
