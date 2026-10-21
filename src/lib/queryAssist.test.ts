import { describe, expect, it } from "vitest";
import { fieldCompletions } from "./queryAssist";

describe("field names offered while typing", () => {
  it("in the user's language first, then the other; none once the name is whole", () => {
    expect(fieldCompletions("login pro", "it")).toEqual(["progetto", "project", "priorità", "priority"].filter(n => n.startsWith("pro")));
    expect(fieldCompletions("-eti", "it")).toEqual(["etichetta"]);
    expect(fieldCompletions("label", "en")).toEqual([]);
    expect(fieldCompletions("project:APP ", "en")).toEqual([]);
  });
});
