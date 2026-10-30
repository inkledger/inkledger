import { describe, expect, it } from "vitest";
import { parseNoteQuery } from "./noteQuery";

const now = new Date(2026, 9, 30, 15, 0);

describe("parseNoteQuery: dates beside the words", () => {
  it("a note's own day, in either language, as day keys (to exclusive)", () => {
    expect(parseNoteQuery("data:ieri riunione", now)).toEqual({ text: "riunione", dates: [{ field: "noted", from: "2026-10-29", to: "2026-10-30" }], bad: [] });
    expect(parseNoteQuery("date:2026-10-01..2026-10-15", now).dates).toEqual([{ field: "noted", from: "2026-10-01", to: "2026-10-16" }]);
    expect(parseNoteQuery("data:settimana", now).dates).toEqual([{ field: "noted", from: "2026-10-26", to: "2026-11-02" }]);
  });

  it("created / updated as instants, with operators", () => {
    const [d] = parseNoteQuery("creata:7d", now).dates;
    expect(d.field).toBe("created");
    expect(new Date(d.from!).getTime()).toBe(new Date(2026, 9, 24).getTime());
    const [u] = parseNoteQuery("updated>2026-10-01 MAGA-12", now).dates;
    expect(u).toEqual({ field: "updated", from: new Date(2026, 9, 2).toISOString(), to: undefined });
  });

  it("keys, links and other words stay text; a negated or unknown term is not a date", () => {
    expect(parseNoteQuery("MAGA-12 https://x.it/a data:oggi", now).text).toBe("MAGA-12 https://x.it/a");
    expect(parseNoteQuery("-data:oggi metadata:oggi", now)).toEqual({ text: "-data:oggi metadata:oggi", dates: [], bad: [] });
  });

  it("a value that is no date is said, not searched as text", () => {
    expect(parseNoteQuery("data:presto note", now)).toEqual({ text: "note", dates: [], bad: ["data:presto"] });
  });
});
