import { describe, it, expect } from "vitest";
import { env, parseAllowedHosts, positiveNumber, serviceEnv } from "./env";

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

  it("new service variables have safe defaults", () => {
    // Nothing set: no outside service is reached, the documented defaults otherwise.
    expect(serviceEnv({})).toEqual({
      ollamaUrl: null,
      ollamaModel: "gemma3:4b",
      ollamaAllowPublic: false,
      forecastUrl: null,
      forecastModel: "Timestral-28M",
      otsExplorer: "https://blockstream.info/api",
      mailCopies: true,
      mailCopyMaxMb: 30,
    });
    const set = serviceEnv({
      OLLAMA_URL: " http://192.168.1.20:11434/ ",
      OLLAMA_MODEL: "qwen3:4b",
      OLLAMA_ALLOW_PUBLIC: "1",
      FORECAST_URL: "http://127.0.0.1:8601",
      FORECAST_MODEL: "Timestral-209M",
      OTS_EXPLORER: "https://mempool.space/api/",
      MAIL_COPIES: "off",
      MAIL_COPY_MAX_MB: "12",
    });
    expect(set).toEqual({
      ollamaUrl: "http://192.168.1.20:11434",
      ollamaModel: "qwen3:4b",
      ollamaAllowPublic: true,
      forecastUrl: "http://127.0.0.1:8601",
      forecastModel: "Timestral-209M",
      otsExplorer: "https://mempool.space/api",
      mailCopies: false,
      mailCopyMaxMb: 12,
    });
    // Unusable values fall back: never a half-set service.
    expect(serviceEnv({ OLLAMA_URL: "ftp://x", FORECAST_URL: "off", OTS_EXPLORER: "nope", MAIL_COPY_MAX_MB: "-1" })).toMatchObject({
      ollamaUrl: null,
      forecastUrl: null,
      otsExplorer: "https://blockstream.info/api",
      mailCopyMaxMb: 30,
    });
    // The server's own env carries them.
    expect(env).toMatchObject({ ollamaModel: expect.any(String), mailCopyMaxMb: expect.any(Number) });
  });
});
