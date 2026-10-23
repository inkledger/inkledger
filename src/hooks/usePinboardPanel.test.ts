import { describe, expect, it } from "vitest";
import { floatHidden, pinboardTarget } from "./usePinboardPanel";

const on = { board: true, menu: true, widget: true };

describe("where the pinboard opens (Settings → Pinboard)", () => {
  it("the widget first, wherever (the Board too); the Board's pin button asks for its panel there", () => {
    expect(pinboardTarget("/board", true, on)).toBe("float");
    expect(pinboardTarget("/issues", true, on)).toBe("float");
    expect(pinboardTarget("/board", true, on, true)).toBe("panel");
    expect(pinboardTarget("/board", false, on, true)).toBe("sheet");
    expect(pinboardTarget("/issues", true, on, true)).toBe("float");
    // Without the widget: on the Board, its panel (a sheet on small screens).
    expect(pinboardTarget("/board", true, { ...on, widget: false })).toBe("panel");
    expect(pinboardTarget("/board", false, { ...on, widget: false })).toBe("sheet");
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

  it("the widget gives way only on the pinboard's own page", () => {
    expect(floatHidden("/pinboard")).toBe(true);
    expect(floatHidden("/board")).toBe(false);
    expect(floatHidden("/issues")).toBe(false);
  });
});
