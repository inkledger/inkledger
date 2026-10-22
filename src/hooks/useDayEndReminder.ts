import { readStored, writeStored } from "@/lib/storage";
import { useEffect } from "react";
import { dayKey } from "@contracts/time";
import { workBounds } from "@contracts/workSchedule";
import { dayReview } from "@/lib/flag";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { useTimers } from "@/hooks/useTimers";
import { isNative, notifyNative } from "@/lib/native";
import { toast } from "sonner";
import { t } from "@/i18n";

const KEY = "ikl-day-end-reminded";
/** Days off (no schedule end): remind at this hour. */
const DAY_OFF_END_HOUR = 20;

/**
 * Once a day, after the end of today's work schedule (20:00 on days off),
 * a gentle toast offers "Close the day" if timers are unlogged.
 */
export function useDayEndReminder() {
  const { forDay, isPending } = useWorkSchedule();
  const { timers } = useTimers();
  const hasPending = timers.length > 0;

  useEffect(() => {
    if (!hasPending || isPending) return;
    const check = () => {
      const now = new Date();
      const end = workBounds(now, forDay(now))?.end;
      const endHour = end
        ? end.getHours() + end.getMinutes() / 60
        : DAY_OFF_END_HOUR;
      if (now.getHours() + now.getMinutes() / 60 < endHour) return;
      const today = dayKey(now);
      if (readStored(KEY) === today) return;
      // Storage unavailable: remind anyway, once per session.
      writeStored(KEY, today);
      // The app may sit hidden in the menu bar: tell the system too.
      if (isNative())
        void notifyNative(
          t("ui.dayEnd.title"),
          t("ui.dayEnd.body")
        );
      toast(t("ui.dayEnd.title"), {
        description: t("ui.dayEnd.body"),
        duration: 15_000,
        action: {
          label: t("ui.dayEnd.action"),
          onClick: () => dayReview.set(true),
        },
      });
    };
    check();
    const i = setInterval(check, 60_000);
    return () => clearInterval(i);
  }, [hasPending, isPending, forDay]);
}
