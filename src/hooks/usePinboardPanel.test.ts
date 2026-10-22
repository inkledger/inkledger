import { describe, expect, it } from "vitest";
import { floatHidden, pinboardTarget } from "./usePinboardPanel";

const on = { board: true, menu: true, widget: true };

describe("where the pinboard opens (Settings → Pinboard)", () => {
  it("on the Board, its own panel (a sheet on small screens); elsewhere the widget", () => {
    expect(pinboardTarget("/board", true, on)).toBe("panel");
    expect(pinboardTarget("/board", false, on)).toBe("sheet");
    expect(pinboardTarget("/issues", true, on)).toBe("float");
  });

  it("without the widget, its page; without that too, the Board with its panel", () => {
    expect(pinboardTarget("/issues", true, { ...on, widget: false })).toBe("page");
    expect(pinboardTarget("/issues", true, { board: true, menu: false, widget: false })).toBe("board");
    // The Board without its panel: the widget there too.
    expect(pinboardTarget("/board", true, { ...on, board: false })).toBe("float");
  });

  it("nowhere when every place is off, or on its own page", () => {
    expect(pinboardTarget("/issues", true, { board: false, menu: false, widget: false })).toBeNull();
    expect(pinboardTarget("/pinboard", true, on)).toBeNull();
  });

  it("the widget gives way where the pinboard already is", () => {
    expect(floatHidden("/pinboard", on)).toBe(true);
    expect(floatHidden("/board", on)).toBe(true);
    expect(floatHidden("/board", { ...on, board: false })).toBe(false);
    expect(floatHidden("/issues", on)).toBe(false);
  });
});
