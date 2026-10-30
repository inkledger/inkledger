import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { IdeaSuggestion } from "@contracts/ideas";
import { formatDuration } from "@contracts/time";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/app/Chip";
import { t } from "@/i18n";

export type SuggestionField = keyof IdeaSuggestion;

/** Shown in this order; "split" makes new ideas, so "Use all" leaves it out (triage Q5). */
const FIELDS: SuggestionField[] = ["title", "problem", "acceptance", "outOfScope", "questions", "labels", "estimateMinutes", "split"];

const label = (f: SuggestionField) =>
  ({
    title: t("pages.ideas.ideaTitle"),
    problem: t("pages.ideas.problem"),
    acceptance: t("pages.ideas.acceptance"),
    outOfScope: t("pages.ideas.outOfScope"),
    questions: t("pages.ideas.questions"),
    labels: t("pages.ideas.labels"),
    estimateMinutes: t("pages.ideas.estimate"),
    split: t("pages.ideas.split"),
  })[f];

const present = (s: IdeaSuggestion, f: SuggestionField) => {
  const v = s[f];
  return Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v !== undefined;
};

/**
 * What the local model suggests, beside nothing saved (docs/work/ideas/triage.md R-2.8):
 * each field is used on its own, or all at once but the split.
 */
export function IdeaSuggestionPanel({
  suggestion,
  model,
  onUse,
  onUseAll,
  onPending,
}: {
  suggestion: IdeaSuggestion;
  model: string;
  onUse: (field: SuggestionField) => void;
  onUseAll: (fields: SuggestionField[]) => void;
  /** Whether something suggested is still unused (closing would lose it) */
  onPending: (pending: boolean) => void;
}) {
  const [used, setUsed] = useState<Set<SuggestionField>>(new Set());
  const fields = FIELDS.filter(f => present(suggestion, f));
  const left = fields.filter(f => !used.has(f));
  useEffect(() => onPending(left.length > 0), [left.length, onPending]);
  const use = (f: SuggestionField) => {
    onUse(f);
    setUsed(u => new Set(u).add(f));
  };
  const all = left.filter(f => f !== "split");
  return (
    <section className="grid gap-3 rounded-md border p-3" aria-label={t("pages.ideas.suggestion", { model })}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body-sm font-medium">{t("pages.ideas.suggestion", { model })}</h3>
        {all.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onUseAll(all);
              setUsed(u => new Set([...u, ...all]));
            }}
          >
            {t("pages.ideas.useAll")}
          </Button>
        )}
      </div>
      <ul className="grid gap-3">
        {fields.map(f => (
          <li key={f} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 text-body-sm">
            <div className="grid gap-1">
              <span className="text-caption text-muted-foreground">{label(f)}</span>
              <SuggestedValue suggestion={suggestion} field={f} />
            </div>
            {used.has(f) ? (
              <span className="flex items-center gap-1 text-caption text-muted-foreground">
                <Check className="h-3.5 w-3.5" aria-hidden /> {t("pages.ideas.used")}
              </span>
            ) : (
              <Button size="sm" variant="outline" aria-label={t("pages.ideas.useField", { field: label(f) })} onClick={() => use(f)}>
                {t("pages.ideas.use")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SuggestedValue({ suggestion, field }: { suggestion: IdeaSuggestion; field: SuggestionField }) {
  const v = suggestion[field];
  if (field === "estimateMinutes" && typeof v === "number") return <span>{formatDuration(v * 60)}</span>;
  if (field === "labels" && Array.isArray(v))
    return (
      <span className="flex flex-wrap gap-1">
        {v.map(l => (
          <Chip key={l}>{l}</Chip>
        ))}
      </span>
    );
  if (Array.isArray(v))
    return (
      <ul className="grid list-disc gap-0.5 pl-4">
        {v.map(item => (
          <li key={item} className="[overflow-wrap:anywhere]">
            {item}
          </li>
        ))}
      </ul>
    );
  return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{String(v)}</span>;
}
