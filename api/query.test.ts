import { describe, expect, it } from "vitest";
import { dateBounds, daySpan, formatQuery, parseQuery, priorityRankOfValue, queryFieldNames, queryText } from "@contracts/query";

const p = (s: string) => parseQuery(s).expr;

describe("query language", () => {
  it("reads text, keys, links and @me", () => {
    expect(p("login bug")).toEqual({ kind: "and", items: [{ kind: "text", text: "login" }, { kind: "text", text: "bug" }] });
    expect(p("APP-12")).toEqual({ kind: "ref", ref: "APP-12" });
    expect(p("acme/web#3")).toEqual({ kind: "ref", ref: "acme/web#3" });
    expect(p("https://x.atlassian.net/browse/APP-1")).toEqual({ kind: "ref", ref: "https://x.atlassian.net/browse/APP-1" });
    expect(p("@me")).toEqual({ kind: "me" });
    expect(p("@io")).toEqual({ kind: "me" });
    expect(p('"login fails"')).toEqual({ kind: "text", text: "login fails" });
  });

  it("reads operators in English and Italian alike", () => {
    expect(p('stato:"In corso"')).toEqual({ kind: "field", field: "status", op: "=", value: "In corso" });
    expect(p("progetto:APP")).toEqual(p("project:APP"));
    expect(p("componente:Backend")).toEqual({ kind: "field", field: "component", op: "=", value: "Backend" });
    expect(p("fonte:GitHub")).toEqual({ kind: "field", field: "source", op: "=", value: "GitHub" });
    expect(p("è:osservata")).toEqual({ kind: "field", field: "is", op: "=", value: "watched" });
    expect(p("cat:incorso")).toEqual({ kind: "field", field: "cat", op: "=", value: "doing" });
    expect(p("priorità>=alta")).toEqual({ kind: "field", field: "priority", op: ">=", value: "high" });
    expect(p("priority:>=high")).toEqual({ kind: "field", field: "priority", op: ">=", value: "high" });
    expect(p('campo."Story points":>3')).toEqual({ kind: "field", field: "field", op: ">", value: "3", name: "Story points" });
  });

  it("excludes with -, groups with parentheses, OR binds looser than AND", () => {
    expect(p("-label:bug")).toEqual({ kind: "not", item: { kind: "field", field: "label", op: "=", value: "bug" } });
    expect(p("project:A status:Open OR project:B")).toEqual({
      kind: "or",
      items: [
        { kind: "and", items: [{ kind: "field", field: "project", op: "=", value: "A" }, { kind: "field", field: "status", op: "=", value: "Open" }] },
        { kind: "field", field: "project", op: "=", value: "B" },
      ],
    });
    expect(p("-(cat:done OR cat:cancelled)")).toEqual({
      kind: "not",
      item: { kind: "or", items: [{ kind: "field", field: "cat", op: "=", value: "done" }, { kind: "field", field: "cat", op: "=", value: "cancelled" }] },
    });
  });

  it("never fails: what can't be read is text or a warning", () => {
    expect(parseQuery("colour:red")).toEqual({ expr: { kind: "text", text: "colour:red" }, warnings: [{ code: "unknownField", at: "colour:red" }] });
    expect(parseQuery("updated:someday").warnings).toEqual([{ code: "badValue", at: "updated:someday" }]);
    expect(parseQuery("status:").warnings).toEqual([{ code: "emptyValue", at: "status:" }]);
    expect(parseQuery("(a b").expr).toEqual({ kind: "and", items: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] });
    expect(parseQuery("a ) b").warnings).toEqual([{ code: "unbalanced", at: ")" }]);
    expect(parseQuery('"open').expr).toEqual({ kind: "text", text: "open" });
    expect(parseQuery("").expr).toBeNull();
  });

  it("writes back in either language, and reads its own writing", () => {
    const q = p('progetto:APP stato:"In corso" -etichetta:bug priorità>=alta aggiornata:7g @io è:osservata (cat:fatta OR cat:annullata)');
    const en = formatQuery(q, "en");
    expect(en).toBe('project:APP status:"In corso" -label:bug priority:>=high updated:7g @me is:watched (cat:done OR cat:cancelled)');
    expect(formatQuery(q, "it")).toBe('progetto:APP stato:"In corso" -etichetta:bug priorità:>=alta aggiornata:7g @io è:osservata (cat:fatta OR cat:annullata)');
    expect(p(en)).toEqual(q);
    expect(p(formatQuery(q, "it"))).toEqual(q);
  });

  it("gives a tracker only the plain words", () => {
    expect(queryText(p("login project:APP fails -crash"))).toBe("login fails");
  });

  it("reads dates as local days", () => {
    const now = new Date(2026, 9, 21, 15, 30); // Wednesday
    expect(daySpan("today", now)).toEqual({ from: new Date(2026, 9, 21), to: new Date(2026, 9, 22) });
    expect(daySpan("7d", now)).toEqual({ from: new Date(2026, 9, 15), to: new Date(2026, 9, 22) });
    expect(daySpan("settimana", now)).toEqual({ from: new Date(2026, 9, 19), to: new Date(2026, 9, 26) });
    expect(daySpan("2026-10-01..2026-10-03", now)).toEqual({ from: new Date(2026, 9, 1), to: new Date(2026, 9, 4) });
    expect(daySpan("2026-02-30", now)).toBeNull();
    expect(dateBounds("<", "today", now)).toEqual({ to: new Date(2026, 9, 21) });
    expect(dateBounds(">=", "ieri", now)).toEqual({ from: new Date(2026, 9, 20) });
  });

  it("ranks priorities by name in both languages", () => {
    expect(["highest", "alta", "media", "low", "minima", "3", "boh"].map(priorityRankOfValue)).toEqual([0, 1, 2, 3, 4, 3, null]);
  });

  it("reads a state word on its own as is: (osservata, preferita…), never a quoted one or a common word", () => {
    expect(parseQuery("osservata login").expr).toEqual({ kind: "and", items: [{ kind: "field", field: "is", op: "=", value: "watched" }, { kind: "text", text: "login" }] });
    expect(parseQuery("-preferite").expr).toEqual({ kind: "not", item: { kind: "field", field: "is", op: "=", value: "favorite" } });
    expect(parseQuery('"osservata"').expr).toEqual({ kind: "text", text: "osservata" });
    expect(parseQuery("aperta").expr).toEqual({ kind: "text", text: "aperta" });
  });
});

describe("queryFieldNames", () => {
  it("names every field once per language, and each name is read as a field", () => {
    for (const lang of ["en", "it"] as const) {
      const names = queryFieldNames(lang);
      expect(new Set(names.map(n => n.field)).size).toBe(names.length);
      for (const { field, name } of names) {
        // Known as a field: read as one, or its value refused (some take dates, categories,
        // flags); never left as plain text.
        const r = parseQuery(`${name}:x`);
        const asField = r.expr?.kind === "field" ? r.expr.field === field : r.warnings.some(w => w.code === "badValue");
        expect(asField, `${lang} ${name}`).toBe(true);
        expect(r.warnings.some(w => w.code === "unknownField"), `${lang} ${name}`).toBe(false);
      }
    }
    expect(queryFieldNames("en").map(n => n.field)).toEqual(queryFieldNames("it").map(n => n.field));
    expect(parseQuery("zzz:x").warnings.map(w => w.code)).toEqual(["unknownField"]);
  });
});

describe("an issue's priority level (the Board's filter)", () => {
  it("the tracker's rank first, else the name in any language, else none", async () => {
    const { priorityLevel } = await import("@contracts/query");
    expect(priorityLevel(0, "Whatever")).toBe(0);
    expect(priorityLevel(null, "Alta")).toBe(1);
    expect(priorityLevel(null, " highest ")).toBe(0);
    expect(priorityLevel(null, "Banale")).toBe(4);
    expect(priorityLevel(null, "Major")).toBe(1);
    expect(priorityLevel(null, "Minore")).toBe(3);
    expect(priorityLevel(null, "Sometime")).toBeNull();
    expect(priorityLevel(null, "")).toBeNull();
    expect(priorityLevel(7, "Bassa")).toBe(3);
  });
});
