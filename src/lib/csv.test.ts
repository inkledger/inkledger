import { describe, it, expect } from "vitest";
import { csvCell } from "./csv";

describe("csvCell", () => {
  it("neutralises text that a spreadsheet would run as a formula", () => {
    expect(csvCell("- fix login")).toBe("'- fix login");
    expect(csvCell('=HYPERLINK("http://x","ok")')).toBe('"\'=HYPERLINK(""http://x"",""ok"")"');
    expect(csvCell("+39 333")).toBe("'+39 333");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("keeps numbers as numbers and quotes separators, per language", () => {
    expect(csvCell(-1.5, "en")).toBe("-1.5");
    expect(csvCell(1234.567, "en")).toBe("1234.57");
    expect(csvCell("a,b", "en")).toBe('"a,b"');
    expect(csvCell(-1.5, "it")).toBe("-1,5");
    expect(csvCell("a;b", "it")).toBe('"a;b"');
    expect(csvCell("plain")).toBe("plain");
  });
});
