import { FirstTrackerBanner } from "@/components/FirstTrackerBanner";
import { useRef } from "react";
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
import { togglePinboard, usePinboardPanel } from "@/hooks/usePinboardPanel";
import { PinboardDialog } from "@/components/board/PinboardDialog";
import { DashboardBackdrop, ModuleSlot, ModulesProvider } from "@/modules/ModuleHost";
import { ModuleSettingsSheet } from "@/modules/ModuleSettingsSheet";
import { NotificationCenter } from "@/components/notifications/NotificationCenter";
import { CreateIssueDialog } from "@/components/issues/CreateIssueDialog";
import { IssueHistoryDialog } from "@/components/issue/IssueHistoryDialog";
import { PALETTE_SHORTCUT } from "@/lib/dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  ActiveTimerChip,
  ActiveTimerNote,
  ActiveTimerRailButton,
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
import { navItems, navEntryFor } from "@/lib/nav";
import { SidebarSection } from "@/components/app/SidebarSection";
import { Kbd } from "@/components/app/Kbd";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { BrandMark } from "@/components/app/BrandMark";
import { BRAND_SHORT } from "@/lib/brand";

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
      className={cn(
        "flex items-center gap-3 rounded-lg px-1.5 py-1",
        collapsed &&
          "justify-center border-transparent bg-transparent p-0 shadow-none"
      )}
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
  const pinboard = usePinboardPanel();

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-5 py-4",
        collapsed ? "px-2.5" : "px-3"
      )}
    >
      <Brand collapsed={collapsed} />

      <RailTip collapsed={collapsed} label={t("ui.layout.searchTip", { shortcut: PALETTE_SHORTCUT })}>
        <button
          type="button"
          onClick={() => commandPalette.set(true)}
          aria-label={collapsed ? t("ui.layout.search") : undefined}
          data-lit="1"
          className={cn(
            "flex items-center gap-2 rounded-md border border-border/80 bg-background py-1.5 text-body-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            collapsed ? "mx-auto h-8 w-10 justify-center px-0" : "px-3"
          )}
        >
          <Search className="h-4 w-4" aria-hidden />
          {!collapsed && (
            <>
              {t("ui.layout.searchEllipsis")}
              <Kbd className="ml-auto">
                {PALETTE_SHORTCUT}
              </Kbd>
            </>
          )}
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
          className={cn(
            "relative -mt-3 flex items-center gap-2.5 rounded-md py-1.5 text-body-sm font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            collapsed ? "mx-auto h-8 w-10 justify-center px-0" : "px-3"
          )}
        >
          <Bell className="h-[18px] w-[18px] shrink-0" aria-hidden />
          {!collapsed && <span>{t("ui.layout.notifications")}</span>}
          {inbox > 0 && (
            <span
              aria-hidden
              data-lit="1"
              className={cn(
                "rounded-full bg-primary-soft text-2xs font-semibold text-primary-strong tabular",
                collapsed
                  ? "absolute right-0.5 top-0.5 h-2 w-2 bg-primary-strong"
                  : "ml-auto px-1.5 py-px"
              )}
            >
              {!collapsed && inbox}
            </span>
          )}
        </button>
      </RailTip>

      <nav
        aria-label={t("ui.layout.mainNav")}
        // Top (brand, search) and bottom (timer, sync, user) never move; on a
        // very short window only this middle part of sections scrolls.
        className="-mx-3 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-3"
      >
        {navItems().map(({ group, title, items }) => {
          const links = items.map(({ to, label, icon: Icon }) => {
            const link = (
              <RailTip key={to} collapsed={collapsed} label={label}>
                {/* Static classes (aria-current) so Tooltip's asChild merge keeps them. */}
                <NavLink
                  to={to}
                  end={to === "/"}
                  aria-label={collapsed ? label : undefined}
                  // Stands out only while current (index.css); keeps its own ::before bar.
                  data-lit="1"
                  data-lit-current=""
                  data-lit-edge="off"
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-md py-1.5 text-body-sm font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground",
                    "aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-strong",
                    "before:absolute before:inset-y-2 before:w-1 before:rounded-r-full before:bg-primary before:opacity-0 aria-[current=page]:before:opacity-100",
                    collapsed
                      ? "mx-auto h-8 w-10 justify-center px-0 before:-left-2.5"
                      : "px-3 before:-left-3",
                    to === "/board" && !collapsed && "pr-9"
                  )}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                  <span className={cn(collapsed && "sr-only")}>{label}</span>
                  {to === "/issues" && unread > 0 && (
                    <span
                      title={t("ui.layout.issuesWithNews", { count: unread })}
                      data-lit="1"
                      className={cn(
                        "rounded-full bg-primary-soft text-2xs font-semibold text-primary-strong tabular",
                        collapsed
                          ? "absolute right-0.5 top-0.5 h-2 w-2 bg-primary-strong"
                          : "ml-auto px-1.5 py-px"
                      )}
                    >
                      <span className={cn(collapsed && "sr-only")}>
                        {unread}
                        <span className="sr-only">{t("ui.layout.withNews")}</span>
                      </span>
                    </span>
                  )}
                </NavLink>
              </RailTip>
            );
            if (to !== "/board" || collapsed) return link;
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
                  onClick={() => togglePinboard(pathname)}
                  className={cn(
                    "absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-primary-strong focus-visible:ring-2 focus-visible:ring-ring/40",
                    panelOpen && "text-primary-strong"
                  )}
                >
                  <Pin className="h-3.5 w-3.5 -rotate-12" aria-hidden />
                </button>
              </div>
            );
          });
          // The icon rail keeps every group open; folded groups hint when
          // the current page or news is inside.
          return collapsed ? (
            <div key={group} className="flex shrink-0 flex-col gap-1">
              <div aria-hidden className="mx-2 mb-1 border-t" />
              {links}
            </div>
          ) : (
            <SidebarSection
              key={group}
              name={group}
              title={title}
              className="shrink-0"
              hint={items.some(
                ({ to }) =>
                  navEntryFor(pathname)?.to === to ||
                  (to === "/issues" && unread > 0)
              )}
            >
              {links}
            </SidebarSection>
          );
        })}
        {!collapsed && <SidebarFavorites />}
      </nav>

      {collapsed ? (
        <ModuleSlot id="sidebar-rail" frame={boxes => <div className="flex shrink-0 flex-col items-center gap-1 pb-2">{boxes}</div>} />
      ) : (
        <ModuleSlot id="sidebar-footer" />
      )}
      <div className="flex shrink-0 flex-col gap-2">
        {collapsed ? (
          <RailTip collapsed label={t("ui.layout.darkTheme")}>
            <Button
              variant="ghost"
              size="icon"
              className="mx-auto h-8 w-10"
              aria-pressed={resolvedTheme === "dark"}
              aria-label={t("ui.layout.darkTheme")}
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <Moon className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </Button>
          </RailTip>
        ) : (
          <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-body-sm font-medium text-muted-foreground hover:text-foreground">
            <Moon
              className="h-[18px] w-[18px]"
              strokeWidth={1.75}
              aria-hidden
            />
            {t("ui.layout.darkTheme")}
            <Switch
              className="ml-auto"
              checked={resolvedTheme === "dark"}
              onCheckedChange={on => setTheme(on ? "dark" : "light")}
            />
          </label>
        )}
        {collapsed ? (
          <ActiveTimerRailButton />
        ) : (
          <div className="grid gap-0.5">
            <div className="flex items-center gap-1">
              <ActiveTimerChip className="min-w-0 flex-1" />
              <ActiveTimerFocusButton />
            </div>
            <ActiveTimerNote />
          </div>
        )}
        <RailTip collapsed={collapsed} label={t("ui.layout.startTimerTip")}>
          <Button
            variant="ghost"
            onClick={() => quickStart.set(true)}
            aria-label={collapsed ? t("ui.layout.startTimer") : undefined}
            className={
              collapsed
                ? "mx-auto h-8 w-10 justify-center px-0"
                : "justify-start"
            }
          >
            <Play className="h-4 w-4" aria-hidden />
            {!collapsed && (
              <>
                {t("ui.layout.startTimer")}
                <Kbd className="ml-auto font-normal text-muted-foreground">
                  T
                </Kbd>
              </>
            )}
          </Button>
        </RailTip>
        <RailTip collapsed={collapsed} label={t("ui.layout.syncJira", { provider })}>
          <Button
            variant="ghost"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            aria-label={collapsed ? t("ui.layout.syncJira", { provider }) : undefined}
            className={
              collapsed
                ? "mx-auto h-8 w-10 justify-center px-0"
                : "h-auto min-h-9 justify-start py-1.5"
            }
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                sync.isPending && "motion-safe:animate-spin"
              )}
              aria-hidden
            />
            {!collapsed && (
              <span className="flex min-w-0 flex-col items-start leading-tight">
                {sync.isPending ? t("ui.layout.syncing") : t("ui.layout.syncJira", { provider })}
                {syncHint && !sync.isPending && (
                  <span
                    className={cn(
                      "truncate text-2xs font-normal",
                      syncError
                        ? "text-warning"
                        : "text-muted-foreground"
                    )}
                    title={syncError ?? undefined}
                  >
                    {syncHint}
                  </span>
                )}
              </span>
            )}
          </Button>
        </RailTip>
        <AccountMenu collapsed={collapsed} side={collapsed ? "right" : "top"} />
        <RailTip collapsed={collapsed} label={t("ui.layout.expandTip")}>
          <Button
            variant="ghost"
            size="sm"
            onClick={sidebar.toggle}
            aria-label={
              collapsed ? t("ui.layout.expand") : t("ui.layout.collapse")
            }
            className={cn(
              "text-muted-foreground",
              collapsed
                ? "mx-auto h-8 w-10 justify-center px-0"
                : "justify-start"
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
            {!collapsed && <span>{t("ui.layout.collapseShort")}</span>}
            {!collapsed && (
              <Kbd className="ml-auto">
                [
              </Kbd>
            )}
          </Button>
        </RailTip>
      </div>
    </div>
  );
}

/** Mobile header: opens the notification center, with a dot when there is news. */
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
        />
      )}
    </Button>
  );
}

/** App shell: grouped sidebar on canvas, content in a single white panel. */
export function AppLayout() {
  useHotkeys();
  useMouseHistoryButtons(isNative());
  useTimerAlerts();
  useLiveSync();
  useNativeBridge();
  useDayEndReminder();
  useNotificationAlerts();
  useThemeSync();
  useSoftKeyboard();
  const collapsed = useSidebarCollapsed();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // A new page starts at the top; Back/Forward land where you were.
  useScrollRestoration(mainRef);
  useNavHistoryRecorder();

  return (
    <TooltipProvider delayDuration={200}>
      <ModulesProvider>
      <div data-lit-stage className="min-h-dvh bg-canvas">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
        >
          {t("ui.layout.skip")}
        </a>

        <aside
          data-lit-ground
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
        <header data-lit-ground className="safe-top sticky top-0 z-30 flex items-center gap-1 border-b bg-canvas/90 px-3 py-1.5 backdrop-blur lg:hidden">
          <Link
            to="/"
            aria-label={t("ui.layout.homeLink")}
            className="flex items-center gap-2 rounded-lg py-1 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
          {/* Under a module's light the panel stands out of the page (desktop only: index.css). */}
          <div data-lit="3" data-lit-wrap data-lit-panel className="group/panel relative rounded-2xl">
            {location.pathname === "/" && <DashboardBackdrop />}
            <main
              id="main"
              ref={mainRef}
              data-lit-face
              // No edge light over the whole panel: it scrolls, a line would scroll with it.
              data-lit-edge="off"
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
              <div
                key={location.pathname}
                className="motion-safe:animate-page-in lg:has-[[data-fill-page]]:flex lg:has-[[data-fill-page]]:min-h-0 lg:has-[[data-fill-page]]:flex-1 lg:has-[[data-fill-page]]:flex-col"
              >
                <Outlet />
              </div>
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
        <PinboardDialog />
        <CreateIssueDialog />
        <IssueHistoryDialog />
        <ModuleSettingsSheet />
      </div>
      </ModulesProvider>
    </TooltipProvider>
  );
}
