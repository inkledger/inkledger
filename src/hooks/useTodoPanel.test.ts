import { describe, expect, it } from "vitest";
import { todoFloatHidden, todoTarget } from "./useTodoPanel";

const on = { menu: true, widget: true, corner: true };

describe("where the TODO list opens (Settings → TODO)", () => {
  it("the widget wherever; without it, its page; nowhere when both are off or already there", () => {
    expect(todoTarget("/board", on)).toBe("float");
    expect(todoTarget("/board", { ...on, widget: false })).toBe("page");
    expect(todoTarget("/board", { menu: false, widget: false, corner: true })).toBeNull();
    expect(todoTarget("/todos", on)).toBeNull();
    expect(todoFloatHidden("/todos")).toBe(true);
    expect(todoFloatHidden("/issues")).toBe(false);
  });
});
