// The code tools of the Desk's chat (docs/work/desk.md, batch 4d): paths confined to a
// repository, globs, the arguments a model sends, and what each result reads like.
import { describe, expect, it } from "vitest";
import { TOOL_RESULT_CHARS, formatToolResult, globMatch, parseToolArgs, repoPathParts } from "./codeTools";

describe("repoPathParts", () => {
  it("a path inside the repository, in its segments", () => {
    expect(repoPathParts("")).toEqual([]);
    expect(repoPathParts(".")).toEqual([]);
    expect(repoPathParts("src/app/Main.kt")).toEqual(["src", "app", "Main.kt"]);
    expect(repoPathParts("./src//app/")).toEqual(["src", "app"]);
    // Windows separators read as separators.
    expect(repoPathParts("src\\app\\Main.kt")).toEqual(["src", "app", "Main.kt"]);
  });

  it("refuses absolute paths, home, drive letters, UNC and ..", () => {
    for (const bad of ["/etc/passwd", "\\etc", "C:\\Windows", "c:/x", "\\\\server\\share", "~/x", "~", "..", "../x", "src/../../x", "src\\..\\..", "a/./../b", "x\0y", "file.txt:stream"])
      expect(repoPathParts(bad), bad).toBeNull();
  });
});

describe("globMatch", () => {
  it("a glob without a slash matches the file name anywhere", () => {
    expect(globMatch("*.kt", "src/app/Main.kt")).toBe(true);
    expect(globMatch("*.kt", "src/app/Main.java")).toBe(false);
    expect(globMatch("Main.?t", "a/Main.kt")).toBe(true);
  });

  it("with a slash, the whole path; ** crosses folders, * does not", () => {
    expect(globMatch("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/c.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/c.ts")).toBe(false);
    expect(globMatch("{src,lib}/*.ts", "lib/c.ts")).toBe(true);
    // Regex characters are literal.
    expect(globMatch("a+b.(x)", "a+b.(x)")).toBe(true);
    expect(globMatch("a+b.(x)", "aab.(x)")).toBe(false);
  });
});

describe("parseToolArgs", () => {
  it("reads what models send: numbers and booleans as strings, defaults filled", () => {
    expect(parseToolArgs("read", { repo: "app", path: "a.ts", from: "10", to: 20 })).toEqual({ ok: true, args: { repo: "app", path: "a.ts", from: 10, to: 20 } });
    expect(parseToolArgs("grep", { repo: 0, query: "MAGA-400", regex: "false" })).toEqual({ ok: true, args: { repo: 0, query: "MAGA-400", regex: false } });
    expect(parseToolArgs("git_log", { repo: "app", grep: "MAGA-400" })).toMatchObject({ ok: true, args: { limit: 10 } });
    expect(parseToolArgs("ls", { repo: "app" })).toEqual({ ok: true, args: { repo: "app", path: "" } });
  });

  it("refuses what can't be run, saying why", () => {
    expect(parseToolArgs("grep", { repo: "app" })).toMatchObject({ ok: false });
    expect(parseToolArgs("git_show", { repo: "app", commit: "HEAD; rm -rf /" })).toMatchObject({ ok: false });
    expect(parseToolArgs("git_show", { repo: "app", commit: "--output=/tmp/x" })).toMatchObject({ ok: false });
    expect(parseToolArgs("git_show", { repo: "app", commit: "1a2B3c4" })).toMatchObject({ ok: true });
    expect(parseToolArgs("read", { repo: "app", path: "a", from: 0 })).toMatchObject({ ok: false });
    expect(parseToolArgs("git_log", { repo: "app", limit: 500 })).toMatchObject({ ok: false });
  });
});

describe("find", () => {
  it("takes a glob and an optional folder", () => {
    expect(parseToolArgs("find", { repo: "app", pattern: "**/*Inventory*" })).toEqual({ ok: true, args: { repo: "app", pattern: "**/*Inventory*", path: "" } });
    expect(parseToolArgs("find", { repo: "app" })).toMatchObject({ ok: false });
    expect(formatToolResult("find", { paths: ["src/Inventory.kt", "src/InventoryService.kt"], truncated: true })).toBe("src/Inventory.kt\nsrc/InventoryService.kt\n(more matches: narrow the pattern)");
  });
});

describe("formatToolResult", () => {
  it("search hits as path:line, a file with its line numbers", () => {
    expect(formatToolResult("grep", { hits: [{ path: "src/a.kt", line: 12, text: "  val x = MAGA-400" }], truncated: false, files: 3 })).toContain("src/a.kt:12: val x = MAGA-400");
    const read = formatToolResult("read", { path: "a.kt", from: 9, to: 10, total: 40, lines: ["one", "two"] });
    expect(read).toContain("9: one\n10: two");
    expect(read).toContain("lines 9–10 of 40");
  });

  it("commits with their files; capped with a note", () => {
    const log = formatToolResult("git_log", { commits: [{ hash: "abc1234def", date: "2026-10-01", subject: "MAGA-400 fix stock", files: [{ status: "M", path: "src/Stock.kt" }] }] });
    expect(log).toContain("abc1234def 2026-10-01 MAGA-400 fix stock");
    expect(log).toContain("M src/Stock.kt");
    const long = formatToolResult("git_show", { text: "x".repeat(TOOL_RESULT_CHARS * 2), truncated: false });
    expect(long.length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
    expect(long).toMatch(/cut here/);
  });
});
