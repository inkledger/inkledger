// Real weather for add-on modules, fetched by the server from Open-Meteo (free,
// no key). Only rounded coordinates leave this server; the browser never calls out.
import { env } from "../lib/env";
import { LruCache } from "../lib/lruCache";

export type WeatherCondition = "clear" | "cloudy" | "rain" | "snow" | "fog" | "storm";
export type Weather = { condition: WeatherCondition; tempC: number; isDay: boolean; cloudCover: number; precipitation: number };
export type Place = { name: string; country: string; lat: number; lon: number };

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 4000;

/** WMO weather interpretation codes, as Open-Meteo reports them. */
export function conditionOf(code: number): WeatherCondition {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code >= 2) return "cloudy";
  return "clear";
}

const round = (n: number) => Math.round(n * 10) / 10;
/** Weather by rounded place: the coordinates come from the page, so the places kept are capped (the most recently asked). */
export const weatherCache = new LruCache<string, { at: number; value: Weather | null }>({ maxEntries: 500 });

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`weather ${res.status}`);
  return res.json();
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The weather now at about (lat, lon), cached 30 minutes; null when off or unreachable. */
export async function weatherAt(lat: number, lon: number, now = Date.now()): Promise<Weather | null> {
  if (!env.weather) return null;
  const [la, lo] = [round(lat), round(lon)];
  const key = `${la},${lo}`;
  const hit = weatherCache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value: Weather | null = null;
  try {
    const q = new URLSearchParams({
      latitude: String(la),
      longitude: String(lo),
      current: "temperature_2m,is_day,weather_code,cloud_cover,precipitation",
    });
    const data = (await getJson(`${FORECAST}?${q.toString()}`)) as { current?: Record<string, unknown> };
    const c = data.current;
    if (c) {
      value = {
        condition: conditionOf(num(c.weather_code)),
        tempC: num(c.temperature_2m),
        isDay: c.is_day === 1,
        cloudCover: num(c.cloud_cover),
        precipitation: num(c.precipitation),
      };
    }
  } catch {
    value = null;
  }
  weatherCache.set(key, { at: now, value });
  return value;
}

/** Places matching a name, for a module's settings; [] when off or unreachable. */
export async function geocode(query: string, language: "en" | "it"): Promise<Place[]> {
  if (!env.weather || query.trim().length < 2) return [];
  try {
    const q = new URLSearchParams({ name: query.trim(), count: "6", language, format: "json" });
    const data = (await getJson(`${GEOCODE}?${q.toString()}`)) as { results?: Record<string, unknown>[] };
    return (data.results ?? []).map(r => ({
      name: str(r.name),
      country: str(r.country),
      lat: round(num(r.latitude)),
      lon: round(num(r.longitude)),
    }));
  } catch {
    return [];
  }
}
