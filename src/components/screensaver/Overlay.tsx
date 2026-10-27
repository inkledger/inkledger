import { useEffect, useMemo, useState } from "react";
import { addDays, formatDurationLong, formatHMS, startOfDay } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { useToday } from "@/hooks/useToday";
import { useElapsed, useTimers } from "@/hooks/useTimers";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { workedSeconds } from "@/lib/worked";
import { dateFormat, t } from "@/i18n";
import { cn } from "@/lib/utils";

/** The time now, refreshed on every minute. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        setNow(new Date());
        next();
      }, 60_000 - (Date.now() % 60_000) + 50);
    };
    next();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** Over the scene: a big clock, the running timer and today's hours towards the goal. */
export function Overlay({ visible }: { visible: boolean }) {
  const now = useClock();
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(x => x.state === "running") ?? null;
  const elapsed = useElapsed(timer?.state ?? "paused", timer?.elapsedSeconds ?? 0, fetchedAt);
  const today = startOfDay(useToday());
  const logs = trpc.worklogs.list.useQuery({ from: today.toISOString(), to: addDays(today, 1).toISOString() });
  const logged = useMemo(() => workedSeconds(logs.data ?? []), [logs.data]);
  const { targetFor } = useWorkSchedule();
  const target = targetFor(today);

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 grid justify-items-center gap-2 px-4 pb-[max(3rem,env(safe-area-inset-bottom))] text-center transition-opacity duration-700",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <time className="font-display text-display tabular text-foreground" dateTime={now.toISOString()}>
        {dateFormat({ hour: "2-digit", minute: "2-digit" }).format(now)}
      </time>
      <p className="text-body-sm text-muted-foreground">{dateFormat({ weekday: "long", day: "numeric", month: "long" }).format(now)}</p>
      {timer && (
        <p className="text-body text-foreground">
          <span className="font-medium text-primary-strong">{timer.issueKey}</span> <span className="tabular">{formatHMS(elapsed)}</span>
        </p>
      )}
      {target > 0 && (
        <p className="text-caption text-muted-foreground">
          {t("ui.focus.todayOf", { logged: formatDurationLong(logged + (timer ? elapsed : 0)), target: formatDurationLong(target) })}
        </p>
      )}
    </div>
  );
}
