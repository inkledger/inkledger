import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/useCountUp";
import { t } from "@/i18n";
import { surface, surfaceFace } from "@/components/app/surface";

export type Stat = {
  label: string;
  value: string;
  tone?: "danger";
  /** Failed to load: the value becomes a retry button. */
  onRetry?: () => void;
};

/**
 * Reference "Quick Stats": warm grainy cover with the title, two white
 * tiles overlapping it, and a short note computed from the data.
 */
export function QuickStatsCard({
  stats,
  note,
  extra,
  title = t("views.dashboard.quickStats.title"),
  cover = "cover-sunset",
}: {
  title?: string;
  /** Cover class for the header band */
  cover?: string;
  stats: [Stat, Stat];
  note?: string;
  extra?: Stat[];
}) {
  return (
    <div {...surface("card", { elevation: 2, role: "wrap" })} className="rounded-xl">
      <div {...surfaceFace()} className="overflow-hidden rounded-xl border bg-card">
        <div className={cn("grain h-24 px-4 pt-3", cover)}>
          <h2 className="font-display text-heading text-cover-title">
            {title}
          </h2>
        </div>
        {/* The face clips (its rounded corners): the tiles keep room for their shadows. */}
        <dl className="stagger -mt-9 grid grid-cols-2 gap-2 pl-[max(0.75rem,var(--surface-reach-l,0px))] pr-[max(0.75rem,var(--surface-reach-r,0px))]">
          {stats.map(s => (
            <div
              key={s.label}
              {...surface("card")}
              className="relative rounded-lg bg-card px-3 py-2.5 shadow-xs"
            >
              <dt className="truncate text-body-sm text-muted-foreground">
                {s.label}
              </dt>
              <dd
                className={cn(
                  "mt-1 font-display text-title tabular",
                  s.tone === "danger" && "text-danger"
                )}
              >
                {/^\d+$/.test(s.value) ? (
                  <CountUpNumber value={Number(s.value)} />
                ) : (
                  s.value
                )}
              </dd>
            </div>
          ))}
        </dl>
        {extra && extra.length > 0 && (
          <dl
            className={cn(
              "grid gap-y-1.5 px-4 pt-3 text-body-sm",
              !note && "pb-4"
            )}
          >
            {extra.map(s => (
              <div
                key={s.label}
                className="flex items-baseline justify-between gap-2"
              >
                <dt className="truncate text-muted-foreground">{s.label}</dt>
                <dd
                  className={cn(
                    "whitespace-nowrap font-medium tabular",
                    s.tone === "danger" && "text-danger"
                  )}
                >
                  {s.onRetry ? (
                    <button
                      type="button"
                      onClick={s.onRetry}
                      className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {s.value} · {t("views.dashboard.quickStats.retry")}
                    </button>
                  ) : (
                    s.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {note && (
          <div className="px-4 pb-4 pt-3">
            <p className="flex items-center gap-1.5 text-body-sm font-semibold">
              <Lightbulb className="h-4 w-4 text-warning" aria-hidden />
              {t("views.dashboard.quickStats.note")}
            </p>
            <p className="mt-1 line-clamp-2 text-body-sm text-muted-foreground">
              {note}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function CountUpNumber({ value }: { value: number }) {
  return <>{Math.round(useCountUp(value))}</>;
}
