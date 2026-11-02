import { bucketsOf } from "@contracts/team";
import { addDays, dayKey, parseDayKey, startOfWeek } from "@contracts/time";
import { cn } from "@/lib/utils";
import { dateFormat } from "@/i18n";
import { cellText, cellsOf, STEP_CLASS, type Person } from "./model";

/**
 * One person's range as a month calendar in the heat map's own colours: a
 * row per week, Monday first, each day a cell with its date; one opens
 * that day. Fits a narrow panel where a day per column would not.
 */
export function TeamCalendar({ person, from, to, today, onDay }: { person: Person; from: string; to: string; today: string; onDay: (day: Date) => void }) {
  const a = parseDayKey(from);
  const b = parseDayKey(to);
  if (!a || !b) return null;
  const days = bucketsOf(a, b, "day");
  const cells = cellsOf(person.days, days, today);
  const byKey = new Map(days.map((d, i) => [d.key, { bucket: d, cell: cells[i] }]));
  const first = startOfWeek(a);
  const weeks: Date[][] = [];
  for (let w = first; w <= b; w = addDays(w, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)));
  const heads = weeks[0].map(d => dateFormat({ weekday: "narrow" }).format(d));
  return (
    <table className="w-full table-fixed border-separate border-spacing-1">
      <thead>
        <tr>
          {heads.map((h, i) => (
            <th key={i} scope="col" className="p-0 text-center text-caption font-normal text-muted-foreground">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map(week => (
          <tr key={dayKey(week[0])}>
            {week.map(d => {
              const at = byKey.get(dayKey(d));
              if (!at) return <td key={dayKey(d)} className="p-0" />;
              const future = at.cell.step === "future";
              return (
                <td key={at.bucket.key} className="p-0">
                  {/* surface: none — a calendar's heat cells are flat data marks, like the map's */}
                  <button
                    type="button"
                    disabled={future}
                    onClick={() => onDay(d)}
                    aria-label={cellText(person.displayName, at.bucket, at.cell)}
                    title={cellText(person.displayName, at.bucket, at.cell)}
                    className={cn(
                      "flex h-8 w-full items-start justify-end rounded-sm p-1 text-caption tabular outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                      STEP_CLASS[at.cell.step],
                      at.cell.step === "off" ? "text-muted-foreground" : "text-foreground/80",
                      !future && "hover:ring-1 hover:ring-foreground/40",
                      at.bucket.key === today && "font-semibold text-foreground"
                    )}
                  >
                    {d.getDate()}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
