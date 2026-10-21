import { describe, expect, it } from "vitest";
import { day, flag, int, oneOf, readFields, text, textSet, writeFields, type Fields } from "./urlCodecs";

type S = { q: string; fav: boolean; page: number; sort: "a" | "b"; from: Date; done: Set<string> };
const FIELDS: Fields<S> = {
  q: { key: "q", fallback: "", codec: text },
  fav: { key: "favorites", fallback: false, codec: flag },
  page: { key: "p", fallback: 1, codec: int },
  sort: { key: "sort", fallback: "a", codec: oneOf(["a", "b"] as const) },
  from: { key: "from", fallback: new Date(2026, 9, 16), codec: day },
  done: { key: "expanded", fallback: new Set(), codec: textSet },
};

describe("url fields", () => {
  it("reads values and falls back on missing or bad ones", () => {
    const s = readFields(new URLSearchParams("q=hello&favorites&p=3&sort=zzz&from=2026-10-01&expanded=B,A"), FIELDS);
    expect(s.q).toBe("hello");
    expect(s.fav).toBe(true);
    expect(s.page).toBe(3);
    expect(s.sort).toBe("a");
    expect(s.from.getDate()).toBe(1);
    expect([...s.done].sort()).toEqual(["A", "B"]);
    expect(readFields(new URLSearchParams("p=-1"), FIELDS).page).toBe(1);
  });

  it("keeps the URL clean: defaults are not written", () => {
    const p = writeFields(new URLSearchParams("x=1"), FIELDS, { q: "", fav: false, page: 1, sort: "b", done: new Set(["Z", "A"]) });
    expect(p.toString()).toBe("x=1&sort=b&expanded=A%2CZ");
    const fav = writeFields(new URLSearchParams(), FIELDS, { fav: true, page: 2 });
    expect(fav.toString()).toBe("favorites=&p=2");
    expect(readFields(fav, FIELDS).fav).toBe(true);
  });
});
