// The shared civil-time formats, held to what each call site wrote by hand before
// (the same Intl options in the same locales): both languages, midnight, invalid input.
import { afterEach, describe, expect, it } from "vitest";
import { setLocaleSource, type Locale } from "@contracts/i18n";
import { dayAndTime, mediumDate, timeOfDay } from "./dates";

const inLocale = (l: Locale) => setLocaleSource(() => l);
const at = new Date(2026, 9, 22, 9, 5); // Thu 22 Oct 2026, 09:05 local
const midnight = new Date(2026, 9, 22, 0, 0);

describe("civil-time formats", () => {
  afterEach(() => setLocaleSource(() => undefined));

  it("timeOfDay: the hand-written { hour, minute } 2-digit format, 24 h in both languages", () => {
    for (const [l, tag] of [["en", "en-GB"], ["it", "it-IT"]] as const) {
      inLocale(l);
      const hand = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" });
      expect(timeOfDay(at)).toBe(hand.format(at));
      expect(timeOfDay(at.getTime())).toBe(hand.format(at));
      expect(timeOfDay(midnight)).toBe(hand.format(midnight));
    }
    inLocale("en");
    expect([timeOfDay(at), timeOfDay(midnight)]).toEqual(["09:05", "00:00"]);
  });

  it("dayAndTime: the hand-written weekday-day-month-hour-minute format", () => {
    const opts = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } as const;
    for (const [l, tag] of [["en", "en-GB"], ["it", "it-IT"]] as const) {
      inLocale(l);
      expect(dayAndTime(at)).toBe(new Intl.DateTimeFormat(tag, opts).format(at));
      expect(dayAndTime(midnight)).toBe(new Intl.DateTimeFormat(tag, opts).format(midnight));
    }
  });

  it("mediumDate: what toLocaleDateString(tag, { dateStyle: medium }) gave, for valid dates", () => {
    for (const [l, tag] of [["en", "en-GB"], ["it", "it-IT"]] as const) {
      inLocale(l);
      expect(mediumDate(at.getTime())).toBe(at.toLocaleDateString(tag, { dateStyle: "medium" }));
      expect(mediumDate(midnight)).toBe(midnight.toLocaleDateString(tag, { dateStyle: "medium" }));
    }
  });

  it("an invalid moment: mediumDate says so as toLocaleDateString did; the clock formats throw, as their Intl did", () => {
    expect(mediumDate(Number.NaN)).toBe(new Date(Number.NaN).toLocaleDateString("en-GB", { dateStyle: "medium" }));
    expect(mediumDate(9e15)).toBe("Invalid Date");
    expect(() => timeOfDay(Number.NaN)).toThrow(RangeError);
    expect(() => dayAndTime(Number.NaN)).toThrow(RangeError);
  });

  it("timeOfDay is the local HH:MM in both languages, every minute of a day and across both DST changes", () => {
    const hand = (t: Date) => `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    for (const l of ["en", "it"] as const) {
      inLocale(l);
      for (const day of [new Date(2026, 9, 22), new Date(2026, 2, 29), new Date(2026, 9, 25)]) {
        for (let m = 0; m < 1440; m++) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);
          expect(timeOfDay(t)).toBe(hand(t));
        }
      }
    }
  });
});
