import { afterEach, describe, expect, it, vi } from "vitest";

describe("weather for modules (Open-Meteo)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const load = async (on = true) => {
    vi.resetModules();
    vi.doMock("../lib/env", async (orig) => ({ env: { ...(await orig<typeof import("../lib/env")>()).env, weather: on } }));
    return import("./openMeteo");
  };

  it("maps WMO codes to a few conditions", async () => {
    const { conditionOf } = await load();
    expect([0, 1, 2, 3, 45, 51, 63, 80, 71, 86, 95, 99].map(conditionOf)).toEqual([
      "clear", "clear", "cloudy", "cloudy", "fog", "rain", "rain", "rain", "snow", "snow", "storm", "storm",
    ]);
  });

  it("sends only rounded coordinates and caches for 30 minutes", async () => {
    const { weatherAt } = await load();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ current: { temperature_2m: 12.5, is_day: 1, weather_code: 61, cloud_cover: 90, precipitation: 0.4 } }));
    });
    const w = await weatherAt(45.4642, 9.19, 0);
    expect(w).toEqual({ condition: "rain", tempC: 12.5, isDay: true, cloudCover: 90, precipitation: 0.4 });
    expect(urls[0]).toContain("latitude=45.5");
    expect(urls[0]).toContain("longitude=9.2");
    await weatherAt(45.47, 9.21, 29 * 60_000);
    expect(urls).toHaveLength(1);
    await weatherAt(45.47, 9.21, 31 * 60_000);
    expect(urls).toHaveLength(2);
  });

  it("answers null when off or unreachable, [] for places", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new Error("down");
    });
    const off = await load(false);
    expect(await off.weatherAt(1, 2)).toBeNull();
    expect(calls).toBe(0);
    const on = await load(true);
    expect(await on.weatherAt(1, 2)).toBeNull();
    expect(await on.geocode("Milano", "it")).toEqual([]);
  });
});
