import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "MCowBQYDK2VwAyEA1etNGb4TL2Eeu60uWvKF9YvAvz3s0dXPL/rAhXx7OQQ=";

describe("the extra trusted module key in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is ignored unless the operator opts in explicitly (anyone holding its private key could ship modules)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MODULES_TRUST_EXTRA_KEY", KEY);
    const { extraKey } = await import("./keys");
    expect(extraKey()).toBeNull();
    vi.stubEnv("MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION", "1");
    expect(extraKey()).toContain("BEGIN PUBLIC KEY");
  });

  it("outside production (development, tests) it is taken as before", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MODULES_TRUST_EXTRA_KEY", KEY);
    const { extraKey } = await import("./keys");
    expect(extraKey()).toContain("BEGIN PUBLIC KEY");
  });
});
