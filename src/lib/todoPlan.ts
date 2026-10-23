import { deviceSetting } from "@/lib/storage";

/** The day this device last planned (the block shows once a day, then on request). */
export const plannedOn = deviceSetting<string | null>("ikl-todo-planned-on", raw => raw, v => v);
/** Suggestions put away today, by source: they come back tomorrow if still news. */
export const putAway = deviceSetting<{ day: string; sources: string[] }>(
  "ikl-todo-suggestions-away",
  raw => {
    try {
      const v: unknown = raw ? JSON.parse(raw) : null;
      if (typeof v === "object" && v !== null && "day" in v && "sources" in v && typeof v.day === "string" && Array.isArray(v.sources))
        return { day: v.day, sources: v.sources.filter((s): s is string => typeof s === "string") };
    } catch {
      // A broken value reads as none.
    }
    return { day: "", sources: [] };
  },
  v => JSON.stringify(v)
);

/** Open the block again today (from the list's button). */
export const replanToday = () => plannedOn.set(null);
export const usePlannedToday = (today: string) => plannedOn.use() === today;
