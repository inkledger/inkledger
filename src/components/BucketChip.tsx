import { Layers, X } from "lucide-react";
import { surface } from "@/components/app/surface";
import { useBuckets } from "@/hooks/useBuckets";
import { t } from "@/i18n";

/** The bucket a list is narrowed to, one click from showing everything. */
export function BucketChip() {
  const { active, choose } = useBuckets();
  if (!active) return null;
  return (
    <div className="mb-3 flex">
      <span {...surface("chip")} className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft py-1 pl-2.5 pr-1 text-caption font-medium text-primary-strong">
        <Layers className="h-3.5 w-3.5" aria-hidden />
        {t("ui.buckets.chip", { name: active.name })}
        <button
          type="button"
          onClick={() => choose(null)}
          aria-label={t("ui.buckets.clear")}
          className="rounded-full p-0.5 transition-colors hover:bg-primary-strong/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    </div>
  );
}
