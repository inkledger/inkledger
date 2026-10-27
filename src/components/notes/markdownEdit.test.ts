import { describe, expect, it } from "vitest";
import { applyMarkdown } from "./markdownEdit";

const at = (start: number, end = start) => ({ start, end });

describe("applyMarkdown", () => {
  it("wraps and unwraps inline selections, including markers outside the selection", () => {
    expect(applyMarkdown("hello world", at(0, 5), "bold")).toMatchObject({
      value: "**hello** world",
      start: 2,
      end: 7,
    });
    expect(applyMarkdown("**hello** world", at(2, 7), "bold")).toMatchObject({
      value: "hello world",
      start: 0,
      end: 5,
    });
    expect(applyMarkdown("**hello** world", at(0, 9), "bold")).toMatchObject({
      value: "hello world",
      start: 0,
      end: 5,
    });
  });

  it("applies block commands to every selected line and toggles tasks cleanly", () => {
    expect(applyMarkdown("one\ntwo", at(0, 7), "numbers").value).toBe(
      "1. one\n2. two"
    );
    expect(applyMarkdown("one\ntwo", at(0, 7), "tasks").value).toBe(
      "- [ ] one\n- [ ] two"
    );
    expect(applyMarkdown("- [ ] one", at(0, 9), "bullets").value).toBe("one");
    expect(applyMarkdown("### title", at(0, 9), "heading").value).toBe("title");
  });

  it("adds and removes fenced code blocks", () => {
    const wrapped = applyMarkdown("const n = 1;", at(0, 12), "codeBlock");
    expect(wrapped.value).toBe("```\nconst n = 1;\n```");
    expect(
      applyMarkdown(wrapped.value, at(0, wrapped.value.length), "codeBlock")
        .value
    ).toBe("const n = 1;");
  });

  it("selects the URL placeholder after inserting a link", () => {
    const edit = applyMarkdown("read this", at(5, 9), "link");
    expect(edit.value).toBe("read [this](https://)");
    expect(edit.value.slice(edit.start, edit.end)).toBe("https://");
  });
});
