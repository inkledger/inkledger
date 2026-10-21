import { useMemo } from "react";
import { useUrlFields } from "@/hooks/useUrlState";
import { oneOf, optionalDay, type Fields } from "@/lib/urlCodecs";
import { useToday } from "@/hooks/useToday";
import { addDays, startOfDay, startOfWeek } from "@contracts/time";

export type PeriodKind = "day" | "week" | "month";

export type PeriodRange = {
  kind: PeriodKind;
  /** Inclusive local start */
  from: Date;
  /** Exclusive local end */
  to: Date;
  /** Every local day in the range */
  days: Date[];
  isCurrent: boolean;
};

/** The period of `kind` that contains `date`. */
export function periodContaining(
  kind: PeriodKind,
  date: Date
): Omit<PeriodRange, "days" | "isCurrent"> {
  if (kind === "day") {
    const from = startOfDay(date);
    return { kind, from, to: addDays(from, 1) };
  }
  if (kind === "week") {
    const from = startOfWeek(date);
    return { kind, from, to: addDays(from, 7) };
  }
  const from = new Date(date.getFullYear(), date.getMonth(), 1);
  return {
    kind,
    from,
    to: new Date(from.getFullYear(), from.getMonth() + 1, 1),
  };
}

/** Start of the period `n` periods after the one starting at `from`. */
export function shiftPeriod(kind: PeriodKind, from: Date, n: number): Date {
  if (kind === "day") return addDays(from, n);
  if (kind === "week") return addDays(from, n * 7);
  return new Date(from.getFullYear(), from.getMonth() + n, 1);
}

/** Range shown for an anchor day (`null` = follow today). */
export function periodRange(
  kind: PeriodKind,
  anchor: Date | null,
  today: Date
): PeriodRange {
  const r = periodContaining(kind, anchor ?? today);
  const days: Date[] = [];
  for (let d = r.from; d < r.to; d = addDays(d, 1)) days.push(d);
  return { ...r, days, isCurrent: r.from <= today && today < r.to };
}

/**
 * Day / week / month navigation state for period views. The shown period is
 * an absolute anchor day, or today: past midnight "today" moves on while a
 * period picked by hand stays put.
 */
export function usePeriod(initial: PeriodKind = "day") {
  // In the URL ("?period=week&from=…"): Back from an issue finds it.
  const fields = useMemo(
    (): Fields<{ kind: PeriodKind; anchor: Date | null }> => ({
      kind: { key: "period", fallback: initial, codec: oneOf(["day", "week", "month"] as const) },
      anchor: { key: "from", fallback: null, codec: optionalDay },
    }),
    [initial]
  );
  const [{ kind, anchor }, set] = useUrlFields(fields);
  const today = useToday();

  const range = useMemo(
    () => periodRange(kind, anchor, today),
    [kind, anchor, today]
  );

  /** Anchor on `date`, or follow today again when it is in today's period. */
  const anchorFor = (k: PeriodKind, date: Date) => {
    const r = periodContaining(k, date);
    return r.from <= today && today < r.to ? null : r.from;
  };

  return {
    range,
    setKind: (k: PeriodKind) => set({ kind: k, anchor: null }),
    prev: () => set({ anchor: anchorFor(kind, shiftPeriod(kind, range.from, -1)) }),
    next: () => set({ anchor: anchorFor(kind, shiftPeriod(kind, range.from, 1)) }),
    reset: () => set({ anchor: null }),
    /** Show the period of the given kind that contains `date`. */
    jumpTo: (date: Date, k: PeriodKind = kind) => set({ kind: k, anchor: anchorFor(k, date) }),
  };
}
