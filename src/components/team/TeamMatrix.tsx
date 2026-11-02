import { memo, useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Bucket, Granularity } from "@contracts/team";
import { formatDurationLong } from "@contracts/time";
import { Dot } from "@/components/app/Chip";
import { surface } from "@/components/app/surface";
import { initials } from "@/lib/initials";
import { cn } from "@/lib/utils";
import { dateFormat, t } from "@/i18n";
import { bucketLabel, cellText, percent, STEP_CLASS, type Cell, type Person } from "./model";

export type MatrixRow = { person: Person; cells: Cell[]; delta: number | null; note: string | null };

/** Cells stretch to fill the panel (a month fits a desktop), within these bounds; narrower, the map scrolls. */
const WIDTH: Record<Granularity, string> = { day: "min-w-5 max-w-10", week: "min-w-9 max-w-16", month: "min-w-12 max-w-20" };

/** Coverage change in points: up, down or even, with its words. */
export function Delta({ value, className }: { value: number | null; className?: string }) {
  if (value === null) return null;
  const Icon = value > 0 ? ArrowUp : ArrowDown;
  return (
    <span
      title={t("pages.team.deltaHint")}
      className={cn("inline-flex items-center gap-0.5 text-caption tabular", value > 0 ? "text-success" : value < 0 ? "text-danger" : "text-muted-foreground", className)}
    >
      {value !== 0 && <Icon aria-hidden className="h-3 w-3" />}
      {t("pages.team.deltaPoints", { delta: value > 0 ? `+${value}` : String(value) })}
    </span>
  );
}

/** The column heads: a day's initial and date, a week's number, a month's name. */
function headOf(b: Bucket): { top: string; bottom: string } {
  if (b.kind === "day") return { top: dateFormat({ weekday: "narrow" }).format(b.from), bottom: String(b.n) };
  if (b.kind === "week") return { top: t("pages.team.weekShort", { n: b.n }), bottom: String(b.from.getDate()) };
  return { top: dateFormat({ month: "short" }).format(b.from), bottom: String(b.from.getFullYear()).slice(2) };
}

const Row = memo(function Row({
  row,
  r,
  rank,
  buckets,
  kind,
  compare,
  activeCol,
}: {
  row: MatrixRow;
  r: number;
  rank: number;
  buckets: Bucket[];
  kind: Granularity;
  compare: boolean;
  /** The column holding the table's one Tab stop on this row (-1: the name; null: another row) */
  activeCol: number | null;
}) {
  const { person: p } = row;
  return (
    <tr className="h-7">
      <th scope="row" className="sticky left-0 z-[5] bg-card p-0 pr-2 text-left font-normal">
        <button
          type="button"
          data-r={r}
          data-c={-1}
          tabIndex={activeCol === -1 ? 0 : -1}
          aria-label={`${t("pages.team.openPerson", { name: p.displayName })}${row.note ? ` (${row.note})` : ""}`}
          className="flex h-7 w-28 min-w-0 items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring sm:w-44"
        >
          <span aria-hidden className="w-5 shrink-0 text-right text-caption text-muted-foreground tabular max-sm:hidden">{rank}</span>
          <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-2xs font-semibold text-primary-strong">
            {initials(p.displayName)}
          </span>
          <span className="min-w-0 flex-1 truncate text-body-sm">{p.displayName}</span>
          {row.note && <Dot tone="warning" />}
        </button>
      </th>
      {row.cells.map((c, i) => {
        const future = c.step === "future";
        const label = cellText(p.displayName, buckets[i], c);
        return (
          <td key={buckets[i].key} className="p-0">
            {/* surface: none — a heat map's cells are flat data marks, thousands of them: nothing stands on or casts from them */}
            <button
              type="button"
              data-r={r}
              data-c={i}
              data-step={c.step}
              tabIndex={activeCol === i ? 0 : -1}
              aria-disabled={future || undefined}
              aria-label={kind === "day" || future ? label : t("pages.team.zoom", { label })}
              className={cn(
                "relative mx-auto flex h-6 w-full items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                WIDTH[kind],
                STEP_CLASS[c.step],
                !future && "hover:ring-1 hover:ring-foreground/40",
                future && "cursor-default"
              )}
            >
              {c.step === "off" && c.logged > 0 && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary-strong/60" />}
            </button>
          </td>
        );
      })}
      <td className="z-[5] bg-card p-0 pl-3 sm:sticky sm:right-0">
        <div className={cn("grid items-baseline justify-items-end gap-x-2 whitespace-nowrap", compare ? "grid-cols-[4rem_2.5rem] sm:grid-cols-[4rem_2.5rem_3.5rem]" : "grid-cols-[4rem_2.5rem]")}>
          <span className="text-body-sm font-semibold tabular">{formatDurationLong(p.loggedSeconds)}</span>
          <span className="text-caption text-muted-foreground tabular">{p.coverage === null ? "—" : percent(p.coverage)}</span>
          {compare && <Delta value={row.delta} className="max-sm:hidden" />}
        </div>
      </td>
    </tr>
  );
});

/**
 * The team at a glance: a row per person, a column per day, week or month,
 * each cell coloured by how much of its expected time was logged. One Tab
 * stop; arrows move, Enter opens. What a cell holds is read out by
 * `onRead` (hover or focus), never drawn in it.
 */
export function TeamMatrix({
  rows,
  team,
  buckets,
  kind,
  today,
  compare,
  onCell,
  onPerson,
  onRead,
}: {
  rows: MatrixRow[];
  team: Cell[];
  buckets: Bucket[];
  kind: Granularity;
  today: string;
  compare: boolean;
  onCell: (row: MatrixRow, bucket: Bucket) => void;
  onPerson: (row: MatrixRow) => void;
  onRead: (text: string | null) => void;
}) {
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const moved = useRef(false);
  const body = useRef<HTMLTableSectionElement>(null);
  const r = Math.min(active.r, rows.length - 1);
  const c = Math.min(active.c, buckets.length - 1);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    body.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)?.focus();
  }, [r, c]);

  const at = (e: SyntheticEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-r]");
    return el ? { r: Number(el.dataset.r), c: Number(el.dataset.c) } : null;
  };
  const read = (e: SyntheticEvent) => {
    const p = at(e);
    if (!p) return;
    if (p.r === -2) onRead(cellText(t("pages.team.team"), buckets[p.c], team[p.c]));
    else if (p.c === -1) onRead(rows[p.r]?.note ?? rows[p.r]?.person.displayName ?? null);
    else onRead(cellText(rows[p.r].person.displayName, buckets[p.c], rows[p.r].cells[p.c]));
  };
  const open = (p: { r: number; c: number }) => {
    const row = rows[p.r];
    if (!row) return;
    if (p.c === -1) return onPerson(row);
    if (row.cells[p.c]?.step === "future") return;
    onCell(row, buckets[p.c]);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step: Record<string, [number, number] | "home" | "end"> = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      Home: "home",
      End: "end",
    };
    const s = step[e.key];
    if (!s) return;
    e.preventDefault();
    moved.current = true;
    if (s === "home") return setActive({ r, c: -1 });
    if (s === "end") return setActive({ r, c: buckets.length - 1 });
    setActive({ r: Math.max(0, Math.min(rows.length - 1, r + s[0])), c: Math.max(-1, Math.min(buckets.length - 1, c + s[1])) });
  };
  const teamMax = Math.max(1, ...team.map(x => Math.max(x.logged, x.target)));

  return (
    <div
      {...surface("ground")}
      className="overflow-x-auto overscroll-x-contain lg:max-h-[calc(100dvh-var(--page-header-h,0px)-15rem)] lg:overflow-y-auto"
      onMouseLeave={() => onRead(null)}
    >
      <table
        aria-label={t("pages.team.matrix", { unit: t(kind === "day" ? "pages.team.unitDay" : kind === "week" ? "pages.team.unitWeek" : "pages.team.unitMonth") })}
        className="w-full border-separate border-spacing-0.5"
        onMouseOver={read}
        onFocus={read}
      >
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 top-0 z-20 bg-card p-0 text-left align-bottom">
              <span className="sr-only">{t("pages.team.person")}</span>
            </th>
            {buckets.map(b => {
              const head = headOf(b);
              const weekend = b.kind === "day" && (b.from.getDay() === 0 || b.from.getDay() === 6);
              const isToday = b.kind === "day" && b.key === today;
              return (
                <th
                  key={b.key}
                  scope="col"
                  title={bucketLabel(b)}
                  className={cn(
                    "bg-card p-0 text-center align-bottom text-caption font-normal leading-tight lg:sticky lg:top-0 lg:z-10",
                    weekend ? "text-muted-foreground/60" : "text-muted-foreground",
                    isToday && "font-semibold text-foreground"
                  )}
                >
                  <span className="sr-only">{bucketLabel(b)}</span>
                  <span aria-hidden className="block">{head.top}</span>
                  <span aria-hidden className="block tabular">{head.bottom}</span>
                </th>
              );
            })}
            <th scope="col" className="top-0 z-20 bg-card p-0 pl-3 text-right align-bottom text-caption font-normal text-muted-foreground sm:sticky sm:right-0 lg:sticky">
              {t("pages.team.total")}
            </th>
          </tr>
          {/* The team's trend: everyone's hours per column against everyone's target. */}
          <tr className="h-8">
            <th scope="row" className="sticky left-0 z-[5] bg-card p-0 pr-2 text-left text-caption font-medium text-muted-foreground">
              <span className="block w-28 px-1 sm:w-44 sm:pl-8">{t("pages.team.team")}</span>
            </th>
            {team.map((x, i) => (
              <td key={buckets[i].key} className="p-0 align-bottom">
                <div data-r={-2} data-c={i} aria-hidden className={cn("relative mx-auto flex h-6 w-full items-end overflow-hidden rounded-sm bg-muted/40", WIDTH[kind])}>
                  {x.target > 0 && (
                    <span className="absolute inset-x-0 border-t border-dashed border-foreground/30" style={{ bottom: `${(x.target / teamMax) * 100}%` }} />
                  )}
                  <span className={cn("w-full", x.step === "future" ? "bg-chart-focus/40" : "bg-chart-focus")} style={{ height: `${(x.logged / teamMax) * 100}%` }} />
                </div>
              </td>
            ))}
            <td className="z-[5] bg-card p-0 pl-3 sm:sticky sm:right-0" />
          </tr>
        </thead>
        <tbody
          ref={body}
          onKeyDown={onKeyDown}
          onClick={e => {
            const p = at(e);
            if (!p || p.r < 0) return;
            setActive(p);
            open(p);
          }}
        >
          {rows.map((row, i) => (
            <Row
              key={row.person.userId}
              row={row}
              r={i}
              rank={i + 1}
              buckets={buckets}
              kind={kind}
              compare={compare}
              activeCol={i === r ? c : null}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
