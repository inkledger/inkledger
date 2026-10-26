import { Link, NavLink } from "react-router";
import { Play } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { visibleIssues, issuePath, issueId } from "@/lib/issues";
import { useTimers } from "@/hooks/useTimers";
import { useStartTimer } from "@/hooks/useStartTimer";
import { SidebarSection } from "@/components/app/SidebarSection";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

/**
 * Favorites in their manual order, one click away: open the issue, or ▶ to
 * start its timer without leaving the page.
 */
export function SidebarFavorites({ onNavigate }: { onNavigate?: () => void }) {
  // The favorites alone: this sidebar is on every page, the whole catalogue isn't needed here.
  const all = trpc.issues.favorites.useQuery(undefined, { staleTime: 60_000 });
  const favorites = visibleIssues(all.data ?? []).filter(i => i.favorite === 1);
  const { timers } = useTimers();
  const start = useStartTimer({ announce: true });
  if (favorites.length === 0) return null;
  const runningKey = timers.find(t => t.state === "running")?.issueKey;

  return (
    // The one part of the sidebar that grows: it scrolls inside, the rest
    // of the sidebar never does.
    <SidebarSection
      name="favorites"
      title={t("ui.sidebar.favorites")}
      className="min-h-0 flex-1"
      bodyClassName="cast-room-x cast-room-y min-h-[4.5rem] flex-1 gap-0.5 overflow-y-auto overscroll-contain [--room-b:1rem] [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
      hint={favorites.some(i => i.unread || i.key === runningKey)}
      action={
        <Link
          to="/issues?favorites"
          onClick={onNavigate}
          className="inline-flex min-h-target items-center text-2xs text-muted-foreground hover:text-foreground"
        >
          {t("ui.sidebar.allFavorites", { count: favorites.length })}
        </Link>
      }
    >
      {favorites.map(i => {
        const running = i.key === runningKey;
        return (
          <div key={issueId(i)} className="group relative">
            <NavLink
              to={issuePath(i)}
              onClick={onNavigate}
              title={`${i.key} · ${i.summary}`}
              {...surface("nav", { current: true, edge: false })}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md py-1 pl-3 pr-8 text-caption text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground",
                "aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-strong"
              )}
            >
              <span
                aria-hidden
                title={i.unread ? t("ui.sidebar.newsSinceVisit") : undefined}
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  running
                    ? "animate-pulse-dot bg-chart-focus"
                    : i.unread
                      ? "bg-primary-strong ring-2 ring-primary-soft"
                      : "bg-border"
                )}
              />
              <span className="shrink-0 font-medium tabular">{i.key}</span>
              <span className="truncate">{i.summary}</span>
            </NavLink>
            {!running && (
              <button
                type="button"
                aria-label={t("ui.sidebar.startTimerOn", { key: i.key })}
                title={t("ui.sidebar.startTimer")}
                disabled={start.isPending}
                onClick={() => start.mutate({ issueKey: i.key, connectionId: i.connectionId })}
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <Play className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </SidebarSection>
  );
}
