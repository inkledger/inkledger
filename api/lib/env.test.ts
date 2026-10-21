import { describe, it, expect } from "vitest";
import { env, parseAllowedHosts, positiveNumber } from "./env";

describe("env", () => {
  it("accepts only positive finite numbers, else the fallback", () => {
    expect(positiveNumber("7", 30)).toBe(7);
    expect(positiveNumber("0.5", 30)).toBe(0.5);
    for (const bad of [undefined, "", " ", "0", "-3", "abc", "Infinity", "NaN"]) {
      expect(positiveNumber(bad, 30), String(bad)).toBe(30);
    }
  });

  it("has a usable session lifetime and pins the time zone", () => {
    expect(env.sessionDays).toBeGreaterThan(0);
    expect(process.env.TZ).toBeTruthy();
  });

  it("defaults allowed hosts to loopback in production only", () => {
    expect(parseAllowedHosts(undefined, true)).toEqual(["localhost", "127.0.0.1", "::1"]);
    expect(parseAllowedHosts(undefined, false)).toEqual([]);
    expect(parseAllowedHosts("*", true)).toEqual([]);
    expect(parseAllowedHosts(" IKL.local , localhost ", true)).toEqual(["ikl.local", "localhost"]);
  });
});
