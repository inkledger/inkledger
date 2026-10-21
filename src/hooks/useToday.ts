import { useEffect, useState } from "react";
import { addDays, dayKey, startOfDay } from "@contracts/time";

/**
 * "Now", stable within a day and refreshed when the day changes (midnight,
 * or coming back to a tab left open overnight): "today" never goes stale.
 */
export function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const refresh = () =>
      setToday(prev => {
        const now = new Date();
        return dayKey(now) === dayKey(prev) ? prev : now;
      });
    const untilMidnight = addDays(startOfDay(new Date()), 1).getTime() - Date.now();
    const timer = setTimeout(refresh, untilMidnight + 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [today]);
  return today;
}
