import { describe, it, expect } from "vitest";
import { env, parseAllowedHosts, positiveNumber, publicUrl, serviceEnv } from "./env";

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

  it("the public dev secret only for the dev server: the built app refuses to start without its own", async () => {
    const { sessionSecretFrom } = await import("./env");
    expect(sessionSecretFrom(undefined, false)).toBe("ikl-dev-secret-change-me");
    expect(() => sessionSecretFrom(undefined, true)).toThrow(/SESSION_SECRET/);
    expect(() => sessionSecretFrom("ikl-dev-secret-change-me", true)).toThrow(/SESSION_SECRET/);
    expect(() => sessionSecretFrom("change-me-with-a-random-string", true)).toThrow(/SESSION_SECRET/);
    expect(sessionSecretFrom("a-real-random-value", true)).toBe("a-real-random-value");
  });

  it("the downloads folder defaults to data/downloads, never a path made from the database URL", async () => {
    const { vi } = await import("vitest");
    const saved = { url: process.env.DATABASE_URL, dir: process.env.DOWNLOADS_DIR };
    process.env.DATABASE_URL = "postgres://ikl:s3cret@db:5432/inkledger";
    delete process.env.DOWNLOADS_DIR;
    vi.resetModules();
    try {
      const fresh = (await import("./env")).env;
      expect(fresh.downloadsDir.endsWith(`${"data"}/downloads`)).toBe(true);
      expect(fresh.downloadsDir).not.toContain("s3cret");
    } finally {
      process.env.DATABASE_URL = saved.url;
      if (saved.dir !== undefined) process.env.DOWNLOADS_DIR = saved.dir;
      vi.resetModules();
    }
  });

  it("PUBLIC_URL: unset is null, a plain http(s) URL is kept without its trailing slash, anything else refuses to start", () => {
    expect(publicUrl(undefined)).toBeNull();
    expect(publicUrl("  ")).toBeNull();
    expect(publicUrl("https://time.example.com/")).toBe("https://time.example.com");
    expect(publicUrl(" https://Time.Example.com:8443/ikl/ ")).toBe("https://time.example.com:8443/ikl");
    expect(publicUrl("http://10.0.0.5:47823")).toBe("http://10.0.0.5:47823");
    for (const bad of ["time.example.com", "/relative", "ftp://time.example.com", "javascript:alert(1)", "https://u:p@time.example.com", "https://time.example.com/?a=1", "https://time.example.com/#x", "https://time.example.com/?"]) {
      expect(() => publicUrl(bad), bad).toThrow(/PUBLIC_URL/);
    }
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
      ollamaChatModel: "gemma3:4b",
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
      OLLAMA_CHAT_MODEL: " qwen3:8b ",
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
      ollamaChatModel: "qwen3:8b",
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
