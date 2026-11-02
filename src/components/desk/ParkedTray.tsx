import { X } from "lucide-react";
import { paneId, type DeskPane } from "@contracts/desk";
import { surface } from "@/components/app/surface";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { trpc } from "@/lib/trpc";
import { projectOf } from "@/lib/projectColors";
import { t } from "@/i18n";

/**
 * The issues parked under the desk (its minimized windows): a click brings one back in
 * place of the focused pane, ✕ takes it off the desk.
 */
export function ParkedTray({ parked, onUnpark, onRemove }: { parked: DeskPane[]; onUnpark: (id: string) => void; onRemove: (id: string) => void }) {
  // Titles from the catalogue already read (the picker's): never a request of its own.
  const known = trpc.issues.all.useQuery(undefined, { enabled: false }).data;
  if (!parked.length) return null;
  const summaryOf = (pane: DeskPane) => known?.find(i => i.connectionId === pane.connectionId && i.key === pane.key)?.summary;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-2.5 md:px-6">
      <h2 className="text-overline uppercase text-muted-foreground">{t("pages.desk.parked")}</h2>
      <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
        {parked.map(pane => {
          const id = paneId(pane);
          const summary = summaryOf(pane);
          return (
            <li key={id} {...surface("chip")} className="flex h-8 min-w-0 items-center rounded-md border bg-background coarse:h-touch">
              <button
                type="button"
                onClick={() => onUnpark(id)}
                title={summary ? `${pane.key}: ${summary}` : undefined}
                aria-label={t("pages.desk.unpark", { key: pane.key })}
                className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md pl-1.5 pr-2 text-body-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ProjectAvatar project={projectOf(pane.key)} connectionId={pane.connectionId} size="xs" className="size-5" />
                {pane.key}
              </button>
              {/* surface: none — the chip's other half: the chip is the surface. */}
              <button
                type="button"
                onClick={() => onRemove(id)}
                aria-label={t("pages.desk.removeParked", { key: pane.key })}
                title={t("pages.desk.removeParked", { key: pane.key })}
                className="flex h-full w-7 items-center justify-center rounded-r-md border-l text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
