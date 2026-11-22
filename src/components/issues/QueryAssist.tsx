import type { QueryTerm } from "@contracts/query";
import { surface } from "@/components/app/surface";
import { fieldCompletions, hasPreset, togglePreset } from "@/lib/queryAssist";
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

/**
 * Under a search box: chips that switch common filters on and off (scrolling
 * sideways on a phone), and the field names the word being typed can start.
 */
export function QueryAssist({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const lang: Lang = useLocale() === "it" ? "it" : "en";
  const toggle = (term: QueryTerm) => onChange(togglePreset(value, term, lang));
  const completions = fieldCompletions(value, lang);
  const complete = (name: string) => onChange(value.replace(/(-?)[^\s:()"]+$/, `$1${name}:`));
  return (
    <div className="grid gap-1.5">
      {completions.length > 0 && (
        // Plain buttons that complete the field name: a group, not a listbox (nothing is ever selected in it).
        <div role="group" aria-label={t("views.issues.assist.fields")} className="flex flex-wrap gap-1.5">
          {completions.map(n => (
            <button
              key={n}
              type="button"
              onClick={() => complete(n)}
              {...surface("chip")}
              className="rounded-md border bg-card px-2 py-0.5 text-caption font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {n}:
            </button>
          ))}
        </div>
      )}
      <div data-overflow-ok role="group" aria-label={t("views.issues.assist.quick")} className="cast-room-x cast-room-y flex snap-x gap-1.5 overflow-x-auto [--room-b:0.25rem] [--room-x:0.25rem] [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
        {/* One scrolling row on a phone; from sm they wrap, so a mouse reaches every chip (none hidden past the edge). */}
        {PRESETS.map(p => (
          <ToggleChip key={p.id} size="sm" className="shrink-0 snap-start" pressed={hasPreset(value, p.term)} onClick={() => toggle(p.term)}>
            {p.label()}
          </ToggleChip>
        ))}
      </div>
    </div>
  );
}
