// The team report's page model: the server's rows cut into the columns
// shown (days, weeks or months), each cell with its step, and the words a
// cell reads as. Pure: the page and its parts share it.
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { coverageStep, type Bucket, type CoverageStep } from "@contracts/team";
import { formatDurationLong } from "@contracts/time";
import { relativeTime } from "@/lib/initials";
import { dateFormat, t } from "@/i18n";

export type Overview = inferRouterOutputs<AppRouter>["team"]["overview"];
export type Person = Overview["people"][number];

export type Cell = { logged: number; target: number; absent: number; step: CoverageStep };

/**
 * A cell's fill: the accent in four clearly apart steps by coverage (the
 * strongest is all of it), and what isn't judged drawn apart: a dashed hole
 * where time was expected and none logged, stripes for time away.
 */
export const STEP_CLASS: Record<CoverageStep, string> = {
  full: "bg-primary",
  high: "bg-primary/55",
  mid: "bg-primary/30",
  low: "bg-primary/12",
  none: "bg-muted border border-dashed border-primary-strong/50",
  off: "",
  absent: "stripes-idle",
  future: "bg-muted/40",
};

/** A person's (or the team's) hours in each column; the target only of days up to `today`. */
export function cellsOf(days: { day: string; loggedSeconds: number; targetSeconds: number; absentSeconds: number }[], buckets: Bucket[], today: string): Cell[] {
  const byDay = new Map(days.map(d => [d.day, d]));
  return buckets.map(b => {
    let logged = 0;
    let target = 0;
    let absent = 0;
    let elapsed = 0;
    for (const key of b.days) {
      const d = byDay.get(key);
      logged += d?.loggedSeconds ?? 0;
      if (key > today) continue;
      elapsed++;
      target += d?.targetSeconds ?? 0;
      absent += d?.absentSeconds ?? 0;
    }
    return { logged, target, absent, step: coverageStep({ loggedSeconds: logged, targetSeconds: target, absentSeconds: absent, future: elapsed === 0 }) };
  });
}

/** Everyone's days added up, day by day: the team row. */
export function teamDays(people: Person[]) {
  const out = new Map<string, { day: string; loggedSeconds: number; targetSeconds: number; absentSeconds: number }>();
  for (const p of people) {
    for (const d of p.days) {
      const acc = out.get(d.day) ?? { day: d.day, loggedSeconds: 0, targetSeconds: 0, absentSeconds: 0 };
      acc.loggedSeconds += d.loggedSeconds;
      acc.targetSeconds += d.targetSeconds;
      acc.absentSeconds += d.absentSeconds;
      out.set(d.day, acc);
    }
  }
  return [...out.values()];
}

export const percent = (share: number) => `${Math.round(share * 100)}%`;

/** A column as words: "Mon 5 Oct", "W41 · 5–11 Oct", "October 2026". */
export function bucketLabel(b: Bucket): string {
  if (b.kind === "day") return dateFormat({ weekday: "short", day: "numeric", month: "short" }).format(b.from);
  if (b.kind === "week") {
    const span = b.days.length === 1
      ? dateFormat({ day: "numeric", month: "short" }).format(b.from)
      : `${b.from.getDate()}–${dateFormat({ day: "numeric", month: "short" }).format(b.to)}`;
    return `${t("pages.team.weekShort", { n: b.n })} · ${span}`;
  }
  return dateFormat({ month: "long", year: "numeric" }).format(b.from);
}

/** What a cell reads as (the readout line and its button's name). */
export function cellText(name: string, b: Bucket, c: Cell): string {
  const when = bucketLabel(b);
  switch (c.step) {
    case "future":
      return t("pages.team.readoutFuture", { name, when });
    case "absent":
      return t("pages.team.readoutAbsent", { name, when });
    case "off":
      return t("pages.team.readoutOff", { name, when, logged: formatDurationLong(c.logged) });
    case "none":
      return t("pages.team.readoutNone", { name, when, target: formatDurationLong(c.target) });
    default:
      return t("pages.team.readout", { name, when, logged: formatDurationLong(c.logged), target: formatDurationLong(c.target), percent: percent(c.logged / c.target) });
  }
}

/** What to warn about a person's time, or null when it can be trusted. */
export function freshnessNote(p: Person, now: number): string | null {
  const { state, at } = p.freshness;
  if (state === "reconnect") return t("pages.team.freshReconnect");
  if (state === "never") return t("pages.team.freshNever");
  if (state === "stale" && at !== null) return t("pages.team.freshStale", { date: relativeTime(new Date(at), now) });
  return null;
}
