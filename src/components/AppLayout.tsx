import { FirstTrackerBanner } from "@/components/FirstTrackerBanner";
import { Suspense, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import {
  Maximize2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Play,
  RefreshCw,
  Search,
  Bell,
  ListChecks,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useAuth } from "@/hooks/useAuth";
import { useTrackerSites } from "@/hooks/useConnections";
import { useHotkeys, useMouseHistoryButtons } from "@/hooks/useHotkeys";
import { useLiveSync } from "@/hooks/useLiveSync";
import { useTimerAlerts } from "@/hooks/useTimerAlerts";
import { useNativeBridge } from "@/hooks/useNativeBridge";
import { isNative } from "@/lib/native";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { useNavHistoryRecorder } from "@/hooks/useNavHistory";
import { useSync } from "@/hooks/useSync";
import { useSyncHint } from "@/hooks/useSyncHint";
import { useSoftKeyboard } from "@/hooks/useSoftKeyboard";
import { AccountMenu } from "@/components/AccountMenu";
import { MobileTabBar } from "@/components/mobile/MobileTabBar";
import { useThemeSync } from "@/hooks/useThemeColor";
import { sidebar, useSidebarCollapsed } from "@/hooks/useSidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { TimerLogHost } from "@/components/TimerLogHost";
import { commandPalette } from "@/lib/commandPalette";
import { notificationCenter } from "@/lib/flag";
import { useShadowReach } from "@/hooks/useShadowReach";
import { openTodosSheet, useTodoSurfacesNow, useTodoWiring } from "@/hooks/useTodoPanel";
import { useTodoReminders, useTodoReminderToast } from "@/hooks/useTodoReminders";
import { TodoWidget } from "@/components/todo/TodoWidget";
import { MakeTodoHost } from "@/components/todo/MakeTodo";
import { HotCorner } from "@/components/todo/HotCorner";
import { togglePinboard, usePinboardPanel, usePinboardTarget, usePinboardWiring } from "@/hooks/usePinboardPanel";
import { PinboardWidget } from "@/components/board/PinboardWidget";
import { StartChoiceDialog } from "@/components/StartChoiceDialog";
import { DashboardBackdrop, ModuleSlot, ModulesProvider } from "@/modules/ModuleHost";
import { ModuleSettingsSheet } from "@/modules/ModuleSettingsSheet";
import { NotificationCenter } from "@/components/notifications/NotificationCenter";
import { CreateIssueDialog } from "@/components/issues/CreateIssueDialog";
import { IssueHistoryDialog } from "@/components/issue/IssueHistoryDialog";
import { PALETTE_SHORTCUT } from "@/lib/dom";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";
import { PageSpinner } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { SwitchLook } from "@/components/ui/switch";
import {
  ActiveTimerChip,
  ActiveTimerNote,
  ActiveTimerRailButton,
  ActiveTimerQuickControls,
} from "@/components/TimerControls";
import { CommandPalette } from "@/components/CommandPalette";
import { QuickStart } from "@/components/QuickStart";
import { IdleDialog } from "@/components/IdleDialog";
import { DayReview } from "@/components/DayReview";
import { FocusMode } from "@/components/FocusMode";
import { LiveTitle } from "@/components/LiveTitle";
import { SidebarFavorites } from "@/components/SidebarFavorites";
import { useUnreadCount } from "@/hooks/useUnreadCount";
import {
  useNotificationAlerts,
  useNotificationCount,
} from "@/hooks/useNotifications";
import { useTimers } from "@/hooks/useTimers";
import { focusMode } from "@/lib/flag";
import { useDayEndReminder } from "@/hooks/useDayEndReminder";
import { quickStart } from "@/lib/quickStart";
import { OutboxBanner } from "@/components/OutboxBanner";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { useNavItems } from "@/lib/nav";
import { Kbd } from "@/components/app/Kbd";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { BrandMark } from "@/components/app/BrandMark";
import { BRAND_SHORT } from "@/lib/brand";
import { pageQueriesOf } from "@/lib/pageQueries";
import { surface, surfaceFace } from "@/components/app/surface";

/** Opens the focus view; shown only while a timer exists. */
function ActiveTimerFocusButton() {
  const { timers } = useTimers();
  if (timers.length === 0) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t("ui.layout.focusMode")}
      title={t("ui.layout.focusMode")}
      onClick={() => focusMode.set(true)}
    >
      <Maximize2 className="h-4 w-4" />
    </Button>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  const { user } = useAuth();
  // The site of the tracker it was set up with, else the account itself.
  const host = useTrackerSites()[0]?.host ?? user?.username ?? "";
  return (
    <Link
      to="/"
      aria-label={t("ui.layout.homeLink")}
      // The mark keeps its place open and closed, under the rows' icons.
      className="flex h-10 shrink-0 items-center gap-3 rounded-lg pl-3"
    >
      <BrandMark className="h-9 w-9" />
      <span className={cn("min-w-0", collapsed && "sr-only")}>
        <span className="block font-display font-semibold leading-tight">
          {BRAND_SHORT}
        </span>
        <span className="block truncate text-caption text-muted-foreground">
          {host}
        </span>
      </span>
    </Link>
  );
}

/** Icon-rail tooltip when collapsed; plain children otherwise. */
function RailTip({
  collapsed,
  label,
  children,
}: {
  collapsed: boolean;
  label: string;
  children: React.ReactElement;
}) {
  if (!collapsed) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function SidebarContent({ collapsed = false }: { collapsed?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const { pathname } = useLocation();
  const sync = useSync();
  const provider = useProviderName();
  const { hint: syncHint, error: syncError } = useSyncHint();
  const unread = useUnreadCount();
  const inbox = useNotificationCount();
  const due = useTodoReminders().items.length;
  // The count beside a section: issues with news, TODOs due today or late.
  const chipOf = (to: string) =>
    to === "/issues" && unread > 0
      ? { count: unread, title: t("ui.layout.issuesWithNews", { count: unread }), sr: t("ui.layout.withNews") }
      : to === "/todos" && due > 0
        ? { count: due, title: t("ui.layout.todosDue", { count: due }), sr: t("ui.layout.forToday") }
        : null;
  const pinboard = usePinboardPanel();
  const navItems = useNavItems();
  // The Board's pin button opens the Board's own panel there; "p" the widget first.
  const pinTarget = usePinboardTarget(pathname, true);

  // One row for both widths: the icon keeps its place while the width
  // animates, the label only shows open. Nothing moves on toggling.
  const row =
    "relative flex h-8 w-full shrink-0 items-center gap-3 rounded-md pl-[21px] pr-2 text-body-sm font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const label = cn("min-w-0 truncate", collapsed && "sr-only");
  const icon = "h-[18px] w-[18px] shrink-0";
  // A count beside a row: a number open, a dot on the icon closed.
  const countChip = (count: number, title?: string, sr?: string) => (
    <span
      title={title}
      {...surface("chip")}
      className={cn(
        "rounded-full bg-primary-soft text-2xs font-semibold text-primary-strong tabular",
        collapsed ? "absolute left-[34px] top-1 h-2 w-2 bg-primary-strong" : "ml-auto px-1.5 py-px"
      )}
    >
      <span className={cn(collapsed && "sr-only")}>
        {count}
        {sr && <span className="sr-only">{sr}</span>}
      </span>
    </span>
  );

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 py-4",
        // Room for the shadows of what it holds (the Shadow mod's reach), the same open and closed.
        "pl-[max(0.5rem,var(--surface-reach-l,0px))] pr-[max(0.5rem,var(--surface-reach-r,0px))]"
      )}
    >
      <Brand collapsed={collapsed} />

      <div className="flex shrink-0 flex-col gap-0.5">
        <RailTip collapsed={collapsed} label={t("ui.layout.searchTip", { shortcut: PALETTE_SHORTCUT })}>
          <button
            type="button"
            onClick={() => commandPalette.set(true)}
            aria-label={collapsed ? t("ui.layout.search") : undefined}
            {...surface("control")}
            className={cn(row, "mb-1 border border-border/80 bg-background pl-5 font-normal hover:bg-background")}
          >
            <Search className={icon} aria-hidden />
            <span className={label}>{t("ui.layout.searchEllipsis")}</span>
            {!collapsed && <Kbd className="ml-auto">{PALETTE_SHORTCUT}</Kbd>}
          </button>
        </RailTip>

        <RailTip collapsed={collapsed} label={t("ui.layout.notificationsTip")}>
          <button
            type="button"
            onClick={() => notificationCenter.set(true)}
            aria-label={
              collapsed || inbox > 0
                ? inbox > 0
                  ? t("ui.layout.notificationsUnseen", { count: inbox })
                  : t("ui.layout.notifications")
                : undefined
            }
            className={row}
          >
            <Bell className={icon} aria-hidden />
            <span className={label}>{t("ui.layout.notifications")}</span>
            {inbox > 0 && <span aria-hidden>{countChip(inbox)}</span>}
          </button>
        </RailTip>
      </div>

      <nav
        aria-label={t("ui.layout.mainNav")}
        // The sections never scroll: only the favorites below them do.
        className="flex shrink-0 flex-col gap-1.5"
      >
        {navItems.map(({ group, title, items }) => {
          const links = items.map(({ to, label: name, icon: Icon }) => {
            const chip = chipOf(to);
            const link = (
              <RailTip key={to} collapsed={collapsed} label={name}>
                {/* Static classes (aria-current) so Tooltip's asChild merge keeps them. */}
                <NavLink
                  to={to}
                  end={to === "/"}
                  aria-label={collapsed ? name : undefined}
                  // Stands out only while current; keeps its own ::before bar.
                  {...surface("nav", { current: true, edge: false })}
                  className={cn(
                    row,
                    "aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-strong",
                    "before:absolute before:-left-2 before:inset-y-2 before:w-1 before:rounded-r-full before:bg-primary before:opacity-0 aria-[current=page]:before:opacity-100",
                    to === "/board" && !collapsed && "pr-9"
                  )}
                >
                  <Icon className={icon} aria-hidden />
                  <span className={label}>{name}</span>
                  {chip && countChip(chip.count, chip.title, chip.sr)}
                </NavLink>
              </RailTip>
            );
            if (to !== "/board" || collapsed || pinTarget === null || pinTarget === "page") return link;
            // The pinboard, one tap away from any page: a sibling of the
            // link, never inside it.
            const panelOpen = pathname === "/board" && pinboard !== "closed";
            return (
              <div key={to} className="relative">
                {link}
                <button
                  type="button"
                  aria-label={t("ui.layout.openPinboard")}
                  title={t("ui.layout.openPinboardTitle")}
                  aria-pressed={panelOpen}
                  onClick={() => togglePinboard(pathname, true)}
                  className={cn(
                    "absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-primary-strong focus-visible:ring-2 focus-visible:ring-ring",
                    panelOpen && "text-primary-strong"
                  )}
                >
                  <Pin className="h-3.5 w-3.5 -rotate-12" aria-hidden />
                </button>
              </div>
            );
          });
          // No titles: a thin line between the sections, open or closed.
          return (
            <div key={group} role="group" aria-label={title} className="flex shrink-0 flex-col gap-0.5">
              <div aria-hidden className="mx-2 mb-1 border-t" />
              {links}
            </div>
          );
        })}
      </nav>

      {/* What is left between the sections and the foot: the favorites, scrolling on their own. */}
      <div className="flex min-h-0 flex-1 flex-col">{!collapsed && <SidebarFavorites />}</div>

      {collapsed ? (
        <ModuleSlot id="sidebar-rail" frame={boxes => <div className="flex shrink-0 flex-col items-center gap-1 pb-2">{boxes}</div>} />
      ) : (
        <ModuleSlot id="sidebar-footer" />
      )}
      <div className="flex shrink-0 flex-col gap-0.5">
        <RailTip collapsed={collapsed} label={t("ui.layout.darkTheme")}>
          <button
            type="button"
            role="switch"
            aria-checked={resolvedTheme === "dark"}
            aria-label={t("ui.layout.darkTheme")}
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className={row}
          >
            <Moon className={icon} strokeWidth={1.75} aria-hidden />
            <span className={label} aria-hidden>
              {t("ui.layout.darkTheme")}
            </span>
            {!collapsed && <SwitchLook className="ml-auto" checked={resolvedTheme === "dark"} />}
          </button>
        </RailTip>
        {collapsed ? (
          <div className="flex flex-col items-center gap-0.5">
            <ActiveTimerRailButton />
            <ActiveTimerQuickControls compact />
          </div>
        ) : (
          <div className="grid gap-0.5">
            <div className="flex items-center gap-1">
              <ActiveTimerChip className="min-w-0 flex-1" />
              <ActiveTimerQuickControls />
              <ActiveTimerFocusButton />
            </div>
            <ActiveTimerNote />
          </div>
        )}
        <RailTip collapsed={collapsed} label={t("ui.layout.startTimerTip")}>
          <button type="button" onClick={() => quickStart.set(true)} aria-label={collapsed ? t("ui.layout.startTimer") : undefined} className={cn(row, "text-foreground")}>
            <Play className={icon} aria-hidden />
            <span className={label}>{t("ui.layout.startTimer")}</span>
            {!collapsed && <Kbd className="ml-auto font-normal text-muted-foreground">T</Kbd>}
          </button>
        </RailTip>
        <RailTip collapsed={collapsed} label={syncHint ? `${t("ui.layout.syncJira", { provider })} · ${syncHint}` : t("ui.layout.syncJira", { provider })}>
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            aria-label={collapsed ? t("ui.layout.syncJira", { provider }) : undefined}
            title={collapsed ? undefined : (syncError ?? undefined)}
            className={cn(row, "disabled:opacity-60")}
          >
            <RefreshCw className={cn(icon, sync.isPending && "motion-safe:animate-spin")} aria-hidden />
            <span className={label}>{sync.isPending ? t("ui.layout.syncing") : t("ui.layout.syncJira", { provider })}</span>
            {!collapsed && syncHint && !sync.isPending && (
              <span className={cn("ml-auto min-w-0 truncate text-2xs font-normal", syncError ? "text-warning" : "text-muted-foreground")}>{syncHint}</span>
            )}
          </button>
        </RailTip>
        <AccountMenu collapsed={collapsed} side={collapsed ? "right" : "top"} />
        <RailTip collapsed={collapsed} label={t("ui.layout.expandTip")}>
          <button
            type="button"
            onClick={sidebar.toggle}
            aria-label={collapsed ? t("ui.layout.expand") : t("ui.layout.collapse")}
            className={cn(row, "font-normal")}
          >
            {collapsed ? <PanelLeftOpen className={icon} aria-hidden /> : <PanelLeftClose className={icon} aria-hidden />}
            <span className={label}>{t("ui.layout.collapseShort")}</span>
            {!collapsed && <Kbd className="ml-auto">[</Kbd>}
          </button>
        </RailTip>
      </div>
    </div>
  );
}

/** Mobile header: opens the notification center, with a dot when there is news. */
/** The phone's way to the TODO list, beside the bell: how many are due today or late, and the list as a sheet. */
function MobileTodos() {
  const due = useTodoReminders().items.length;
  const { pathname } = useLocation();
  const s = useTodoSurfacesNow();
  if (!(s.menu || s.widget) || pathname === "/todos") return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative shrink-0"
      aria-label={due > 0 ? t("ui.layout.todosDue", { count: due }) : t("ui.todoFloat.open")}
      onClick={openTodosSheet}
    >
      <ListChecks className="h-5 w-5" />
      {due > 0 && (
        <span aria-hidden className="absolute right-1 top-1 min-w-4 rounded-full bg-primary-strong px-1 text-2xs font-semibold leading-4 text-primary-foreground tabular" {...surface("chip")}>
          {due}
        </span>
      )}
    </Button>
  );
}

function MobileBell() {
  const inbox = useNotificationCount();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative shrink-0"
      aria-label={
        inbox > 0
          ? t("ui.layout.notificationsUnseen", { count: inbox })
          : t("ui.layout.notifications")
      }
      onClick={() => notificationCenter.set(true)}
    >
      <Bell className="h-5 w-5" />
      {inbox > 0 && (
        <span
          aria-hidden
          className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary-strong"
          {...surface("chip")}
        />
      )}
    </Button>
  );
}

/**
 * The shell's background duties (alerts, live sync, the native bridge, reminders): effects
 * only, on queries that change often. Kept in a component of their own that draws nothing,
 * so their data re-renders it alone, not the whole shell.
 */
function ShellWatchers() {
  useTimerAlerts();
  useLiveSync();
  useNativeBridge();
  useDayEndReminder();
  useNotificationAlerts();
  useTodoReminderToast();
  return null;
}

/** App shell: grouped sidebar on canvas, content in a single white panel. */
export function AppLayout() {
  useHotkeys();
  usePinboardWiring();
  useShadowReach();
  useTodoWiring();
  useMouseHistoryButtons(isNative());
  useThemeSync();
  useSoftKeyboard();
  const collapsed = useSidebarCollapsed();
  const location = useLocation();
  // One page, one key: the settings' categories are frames of one page (only the frame changes).
  const pageKey = location.pathname.startsWith("/settings") ? "/settings" : location.pathname;
  const queryClient = useQueryClient();
  const mainRef = useRef<HTMLElement>(null);
  // A new page starts at the top; Back/Forward land where you were.
  useScrollRestoration(mainRef);
  useNavHistoryRecorder();

  return (
    <TooltipProvider delayDuration={200}>
      <ShellWatchers />
      <ModulesProvider>
      <div data-surface-stage className="min-h-dvh bg-canvas">
        {/* App-wide modules (the Shadow's light): mounted once, never with a page. */}
        <ModuleSlot id="app-stage" />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
        >
          {t("ui.layout.skip")}
        </a>

        <aside
          {...surface("ground")}
          className={cn(
            // Never scrolls: only the favorites list inside does.
            "fixed inset-y-0 left-0 hidden overflow-hidden transition-[width] duration-slow lg:block",
            collapsed ? "w-[76px]" : "w-[264px]"
          )}
        >
          <SidebarContent collapsed={collapsed} />
        </aside>

        {/* Phones and tablets: sections and the timer live in the tab bar;
            the header keeps what is reached from anywhere. */}
        <header {...surface("glass")} className="safe-top sticky top-0 z-30 flex items-center gap-1 border-b bg-canvas/90 px-3 py-1.5 backdrop-blur lg:hidden">
          <Link
            to="/"
            aria-label={t("ui.layout.homeLink")}
            className="flex items-center gap-2 rounded-lg py-1 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BrandMark className="h-8 w-8" />
            <span className="font-display font-semibold">{BRAND_SHORT}</span>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto shrink-0"
            aria-label={t("ui.layout.search")}
            onClick={() => commandPalette.set(true)}
          >
            <Search className="h-5 w-5" />
          </Button>
          <MobileTodos />
          <MobileBell />
        </header>

        <div
          className={cn(
            "p-2 transition-[padding] duration-slow sm:p-3 lg:py-4 lg:pr-4",
            // Phones: clear of the tab bar (or, with the keyboard up, the home
            // indicator) and of the rounded corners.
            "max-lg:pb-[max(calc(var(--bottom-nav-h)+var(--dock-h)+0.5rem),env(safe-area-inset-bottom,0px))] max-lg:pl-[max(0.5rem,env(safe-area-inset-left))] max-lg:pr-[max(0.5rem,env(safe-area-inset-right))]",
            collapsed ? "lg:pl-[76px]" : "lg:pl-[264px]"
          )}
        >
          {/* Desktop: the panel stays put (rounded, same top margin) and scrolls inside, so a
              sticky page header stays at its top. Mobile: the window scrolls. */}
          {/* On the Dashboard an add-on may paint a scene behind the page: the panel turns see-through. */}
          {/* Under a light (Shadow module) the panel stands out of the page. */}
          <div {...surface("panel", { elevation: 3, role: "wrap" })} data-surface-panel className="group/panel relative rounded-2xl">
            {location.pathname === "/" && <DashboardBackdrop />}
            <main
              id="main"
              ref={mainRef}
              // No edge light over the whole panel: it scrolls, a line would scroll with it.
              {...surfaceFace({ edge: false })}
              className={cn(
                "relative min-h-[calc(100dvh_-_2rem_-_var(--bottom-nav-h))] overflow-clip rounded-2xl border bg-card shadow-xs lg:h-[calc(100dvh-2rem)] lg:min-h-0 lg:overflow-y-auto",
                "group-has-[[data-module-slot=dashboard-backdrop]]/panel:bg-transparent",
                // A page marked data-fill-page (Board) fills the panel exactly
                // and scrolls inside its own parts; other pages are unchanged.
                "lg:has-[[data-fill-page]]:flex lg:has-[[data-fill-page]]:flex-col lg:has-[[data-fill-page]]:overflow-hidden"
              )}
            >
              <ReconnectBanner />
              <FirstTrackerBanner />
              <OutboxBanner />
              {/* The page alone waits for its code or fails: the shell (sidebar, header, timer) stays.
                  Outside the page's keyed box, so they outlive a navigation: the page on screen
                  stays until the next one's code is there (the router navigates in a transition). */}
              <ErrorBoundary resetKey={pageKey} onRetry={() => pageQueriesOf(queryClient).dropInactive(location.pathname)}>
                <Suspense fallback={<PageSpinner />}>
                  <div
                    key={pageKey}
                    className="motion-safe:animate-page-in lg:has-[[data-fill-page]]:flex lg:has-[[data-fill-page]]:min-h-0 lg:has-[[data-fill-page]]:flex-1 lg:has-[[data-fill-page]]:flex-col"
                  >
                    <Outlet />
                  </div>
                </Suspense>
              </ErrorBoundary>
            </main>
          </div>
          {/* Add-on modules' anchor on the panel's bottom-left corner: zero size,
              fixed, never part of the layout. On phones the page scrolls as a
              whole: the anchor stands on the tab bar's top edge (the screen's
              bottom while the keyboard hides the bar). */}
          <div
            className={cn(
              "pointer-events-none fixed z-20 h-0 w-0",
              "bottom-[var(--bottom-nav-h,0px)] left-[max(0.5rem,env(safe-area-inset-left))] sm:left-3 lg:bottom-4",
              collapsed ? "lg:left-[76px]" : "lg:left-[264px]"
            )}
          >
            <ModuleSlot id="panel-edge" />
          </div>
        </div>
        <MobileTabBar />
        <CommandPalette />
        <QuickStart />
        <IdleDialog />
        <DayReview />
        <FocusMode />
        <LiveTitle />
        <ShortcutsDialog />
        <TimerLogHost />
        <NotificationCenter />
        <PinboardWidget />
        <TodoWidget />
        <MakeTodoHost />
        <HotCorner />
        <StartChoiceDialog />
        <CreateIssueDialog />
        <IssueHistoryDialog />
        <ModuleSettingsSheet />
      </div>
      </ModulesProvider>
    </TooltipProvider>
  );
}
