import { formatQuery, parseQuery, type QueryExpr, type QueryTerm } from "@contracts/query";
import { surface } from "@/components/app/surface";
import { fieldCompletions } from "@/lib/queryAssist";
import { ToggleChip } from "@/components/app/ToggleChip";
import { t, useLocale } from "@/i18n";

type Lang = "en" | "it";

/** One-tap filters, written in the query language (so the box always says what is on). */
const PRESETS: { id: string; term: QueryTerm; label: () => string }[] = [
  { id: "me", term: { kind: "me" }, label: () => t("views.issues.assist.mine") },
  { id: "doing", term: { kind: "field", field: "cat", op: "=", value: "doing" }, label: () => t("views.issues.assist.doing") },
  { id: "unread", term: { kind: "field", field: "is", op: "=", value: "unread" }, label: () => t("views.issues.assist.unread") },
  { id: "watched", term: { kind: "field", field: "is", op: "=", value: "watched" }, label: () => t("views.issues.assist.watched") },
  { id: "high", term: { kind: "field", field: "priority", op: ">=", value: "high" }, label: () => t("views.issues.assist.high") },
  { id: "week", term: { kind: "field", field: "updated", op: "=", value: "week" }, label: () => t("views.issues.assist.week") },
  { id: "today", term: { kind: "field", field: "logged", op: "=", value: "today" }, label: () => t("views.issues.assist.loggedToday") },
];

const same = (a: QueryExpr, b: QueryTerm) => formatQuery(a, "en") === formatQuery(b, "en");
/** The query's parts joined by AND (one part when there is no AND at the top). */
const partsOf = (expr: QueryExpr | null): QueryExpr[] => (!expr ? [] : expr.kind === "and" ? expr.items : [expr]);

/**
 * Under a search box: chips that switch common filters on and off (scrolling
 * sideways on a phone), and the field names the word being typed can start.
 */
export function QueryAssist({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const lang: Lang = useLocale() === "it" ? "it" : "en";
  const parts = partsOf(parseQuery(value).expr);
  const toggle = (term: QueryTerm) => {
    const on = parts.some(p => same(p, term));
    const next = on ? parts.filter(p => !same(p, term)) : [...parts, term];
    onChange(next.length === 0 ? "" : formatQuery(next.length === 1 ? next[0] : { kind: "and", items: next }, lang) + " ");
  };
  const completions = fieldCompletions(value, lang);
  const complete = (name: string) => onChange(value.replace(/(-?)[^\s:()"]+$/, `$1${name}:`));
  return (
    <div className="grid gap-1.5">
      {completions.length > 0 && (
        <div role="listbox" aria-label={t("views.issues.assist.fields")} className="flex flex-wrap gap-1.5">
          {completions.map(n => (
            <button
              key={n}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => complete(n)}
              {...surface("chip")}
              className="rounded-md border bg-card px-2 py-0.5 text-caption font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {n}:
            </button>
          ))}
        </div>
      )}
      <div role="group" aria-label={t("views.issues.assist.quick")} className="cast-room-x cast-room-y flex snap-x gap-1.5 overflow-x-auto [--room-b:0.25rem] [--room-x:0.25rem] [scrollbar-width:none]">
        {PRESETS.map(p => (
          <ToggleChip key={p.id} size="sm" className="shrink-0 snap-start" pressed={parts.some(x => same(x, p.term))} onClick={() => toggle(p.term)}>
            {p.label()}
          </ToggleChip>
        ))}
      </div>
    </div>
  );
}
