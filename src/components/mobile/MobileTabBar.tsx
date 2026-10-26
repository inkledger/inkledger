import { useState } from "react";
import { NavLink, useLocation } from "react-router";
import { Ellipsis, Play } from "lucide-react";
import { formatHMS } from "@contracts/time";
import { useElapsed, useTimers } from "@/hooks/useTimers";
import { useUnreadCount } from "@/hooks/useUnreadCount";
import { quickStart } from "@/lib/quickStart";
import { navEntryFor, navItems, TAB_ROUTES } from "@/lib/nav";
import { TimerRing } from "@/components/TimerControls";
import { MobileTimerSheet } from "@/components/mobile/MobileTimerSheet";
import { MobileMoreSheet } from "@/components/mobile/MobileMoreSheet";
import { ModuleSlot } from "@/modules/ModuleHost";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

const CELL =
  "relative flex min-h-touch min-w-0 flex-col items-center justify-center gap-0.5 rounded-md text-2xs font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** Active tab: accent text and a short bar on the top edge (as in the sidebar). */
const ACTIVE =
  "text-primary-strong before:absolute before:-top-1 before:h-0.5 before:w-6 before:rounded-full before:bg-primary";

function Tab({ to }: { to: string }) {
  const { pathname } = useLocation();
  const unread = useUnreadCount();
  const item = navItems()
    .flatMap(g => g.items)
    .find(i => i.to === to);
  if (!item) return null;
  const { label, icon: Icon } = item;
  const news = to === "/issues" && unread > 0;
  return (
    <NavLink
      to={to}
      end={to === "/"}
      onClick={e => {
        // Tapping the page you are on takes you back to its top.
        if (pathname !== to) return;
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }}
      className={({ isActive }) => cn(CELL, isActive && ACTIVE)}
      // Stands out only while it is the current page (aria-current, set by NavLink).
      {...surface("nav", { current: true, edge: false })}
    >
      <span className="relative">
        <Icon className="h-5 w-5" aria-hidden />
        {news && (
          <span
            aria-hidden
            className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-primary-strong ring-2 ring-canvas"
            {...surface("chip")}
          />
        )}
      </span>
      <span className="max-w-full truncate">{label}</span>
      {news && (
        <span className="sr-only">
          {t("ui.layout.issuesWithNews", { count: unread })}
        </span>
      )}
    </NavLink>
  );
}

/**
 * The bar's center: starts a timer when none exists, otherwise shows the
 * tracked one live and opens the timers sheet.
 */
function TimerButton({ onOpen }: { onOpen: () => void }) {
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(t => t.state === "running") ?? timers[0];
  const elapsed = useElapsed(timer?.state ?? "paused", timer?.elapsedSeconds ?? 0, fetchedAt);
  // Raised by its offset, not a transform: a transform would make it its own
  // layer and a light's shadow would fall on its face.
  const round =
    "relative -top-3 flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-full shadow-sm ring-4 ring-canvas transition-colors focus-visible:outline-none focus-visible:ring-ring";

  if (!timer) {
    return (
      <button
        type="button"
        aria-label={t("ui.layout.startTimer")}
        onClick={() => quickStart.set(true)}
        {...surface("control")}
        className={cn(round, "bg-primary text-primary-foreground active:bg-primary-strong")}
      >
        <Play className="h-5 w-5 translate-x-px" fill="currentColor" aria-hidden />
      </button>
    );
  }
  const running = timer.state === "running";
  const hms = formatHMS(elapsed);
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={t(running ? "ui.timer.activeOnLabel" : "ui.timer.pausedOnLabel", {
        key: timer.issueKey,
        time: hms,
      })}
      onClick={onOpen}
      {...surface("control")}
      className={cn(round, "border bg-card active:bg-accent")}
    >
      <TimerRing running={running} className="h-5 w-5" />
      <span
        className={cn(
          "text-2xs font-semibold leading-none tabular",
          running ? "text-foreground" : "text-warning"
        )}
      >
        {hms.slice(0, -3)}
      </span>
    </button>
  );
}

/**
 * Phones and tablets: the sections used all day and the timer, one tap away
 * at the bottom of the screen. Steps aside while the soft keyboard is up.
 */
export function MobileTabBar() {
  const { pathname } = useLocation();
  const [timersOpen, setTimersOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const entry = navEntryFor(pathname);
  const inMore =
    entry !== null && !TAB_ROUTES.includes(entry.to);

  return (
    <>
      <nav
        aria-label={t("ui.layout.tabBar")}
        data-tab-bar
        {...surface("glass")}
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 border-t bg-canvas/90 backdrop-blur lg:hidden [html[data-keyboard]_&]:hidden",
          "pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
        )}
      >
        {/* Add-ons' anchor on the bar's top-right edge (e.g. a player while music plays). */}
        <div className="absolute right-[max(0.5rem,env(safe-area-inset-right))] top-0 h-0 w-0">
          <ModuleSlot id="mobile-dock" />
        </div>
        <div className="mx-auto grid h-14 max-w-md grid-cols-5 items-center px-1">
          <Tab to="/" />
          <Tab to="/board" />
          <div className="flex justify-center">
            <TimerButton onOpen={() => setTimersOpen(true)} />
          </div>
          <Tab to="/issues" />
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={inMore ? "page" : undefined}
            onClick={() => setMoreOpen(true)}
            className={cn(CELL, inMore && ACTIVE)}
            {...surface("nav", { current: true, edge: false })}
          >
            <Ellipsis className="h-5 w-5" aria-hidden />
            <span className="max-w-full truncate">{t("ui.layout.more")}</span>
          </button>
        </div>
      </nav>
      <MobileTimerSheet open={timersOpen} onOpenChange={setTimersOpen} />
      <MobileMoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
    </>
  );
}
