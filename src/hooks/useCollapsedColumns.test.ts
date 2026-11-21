import { describe, expect, it } from "vitest";
import { toggledColumns } from "./useCollapsedColumns";

describe("folding a board column", () => {
  it("toggles it in the whole list, every board's", () => {
    expect(toggledColumns("board:Done", null, ["ideas:raw"])).toEqual(["ideas:raw", "board:Done"]);
    expect(toggledColumns("board:Done", null, ["ideas:raw", "board:Done"])).toEqual(["ideas:raw"]);
  });

  it("builds on the saves still under way", () => {
    expect(toggledColumns("board:Doing", ["board:Done"], [])).toEqual(["board:Done", "board:Doing"]);
  });

  // The server replaces the whole list: a toggle built on nothing unfolded every board's columns.
  it("does nothing before the setting is read", () => {
    expect(toggledColumns("board:Done", null, undefined)).toBeNull();
  });
});
