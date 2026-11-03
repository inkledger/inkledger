import { usePublishChromeHeight } from "@/lib/layout/chrome";
import { lazyPart } from "@/components/app/lazyPart";
import { PinMailHost } from "@/components/mail/PinMailHost";
import { FirstTrackerBanner } from "@/components/FirstTrackerBanner";
import { memo, Suspense, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import {
  Maximize2,
  Moon,
  ChevronsLeft,
  ChevronsRight,
  Pin,
  Play,
  RefreshCw,
  Search,
  Bell,
  ListChecks,
  Sparkles,
} from "lucide-react";
import { useTheme } from "next-themes";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useTrackerSites } from "@/hooks/useConnections";
import { useHotkeys, useMouseHistoryButtons } from "@/hooks/useHotkeys";
import { useOpenBeside } from "@/hooks/useOpenBeside";
import { DeskDropTarget } from "@/components/desk/DeskDropTarget";
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
import { commandPalette, useCommandPaletteShortcut } from "@/lib/commandPalette";
import { notificationCenter, screensaver } from "@/lib/flag";
import { useShadowReach } from "@/hooks/useShadowReach";
import { openTodosSheet, useTodoSurfacesNow, useTodoWiring } from "@/hooks/useTodoPanel";
import { useTodoReminders, useTodoReminderToast } from "@/hooks/useTodoReminders";
import { TodoWidget } from "@/components/todo/TodoWidget";
import { HotCorner } from "@/components/todo/HotCorner";
import { togglePinboard, usePinboardPanel, usePinboardTarget, usePinboardWiring } from "@/hooks/usePinboardPanel";
import { PinboardWidget } from "@/components/board/PinboardWidget";
import { DashboardBackdrop, ModuleSlot, ModulesProvider } from "@/modules/ModuleHost";
import { WorkspaceScopeProvider } from "@/lib/workspace/provider";
import { WorkspaceInteractionBoundary } from "@/lib/workspace/interaction";
import { useWorkspace } from "@/lib/workspace/context";
import { FlowControlHost, flowControlProps } from "@/lib/workspace/instrumentation";
import { routeControlId } from "@/lib/workspace/searchEvents";
import { ModuleSettingsSheet } from "@/modules/ModuleSettingsSheet";
import { NotificationCenter } from "@/components/notifications/NotificationCenter";
import { PALETTE_SHORTCUT } from "@/lib/dom";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";
import { PageSpinner } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import {
  ActiveTimerChip,
  ActiveTimerNote,
  ActiveTimerRailPlayer,
  ActiveTimerQuickControls,
} from "@/components/TimerControls";
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
import { isPlaced, placementsFor } from "@/lib/workspace/utils";

// Dialogs and hosts opened on demand: out of the first load (each fetched right after it).
const QuickStart = lazyPart(() => import("@/components/QuickStart").then(m => m.QuickStart));
const IdleDialog = lazyPart(() => import("@/components/IdleDialog").then(m => m.IdleDialog));
const DayReview = lazyPart(() => import("@/components/DayReview").then(m => m.DayReview));
const FocusMode = lazyPart(() => import("@/components/FocusMode").then(m => m.FocusMode));
const Screensaver = lazyPart(() => import("@/components/screensaver/Screensaver").then(m => m.Screensaver));
const ShortcutsDialog = lazyPart(() => import("@/components/ShortcutsDialog").then(m => m.ShortcutsDialog));
const StartChoiceDialog = lazyPart(() => import("@/components/StartChoiceDialog").then(m => m.StartChoiceDialog));
const CreateIssueDialog = lazyPart(() => import("@/components/issues/CreateIssueDialog").then(m => m.CreateIssueDialog));
const IdeaCaptureDialog = lazyPart(() => import("@/components/ideas/IdeaCaptureDialog").then(m => m.IdeaCaptureDialog));
const IssueHistoryDialog = lazyPart(() => import("@/components/issue/IssueHistoryDialog").then(m => m.IssueHistoryDialog));
// The palette's body: its ⌘K stays in the first load (useCommandPaletteShortcut), so a key pressed at once is never lost.
const CommandPalette = lazyPart(() => import("@/components/CommandPalette").then(m => m.CommandPalette));
const TimerLogHost = lazyPart(() => import("@/components/TimerLogHost").then(m => m.TimerLogHost));
const MakeTodoHost = lazyPart(() => import("@/components/todo/MakeTodo").then(m => m.MakeTodoHost));

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
      {...flowControlProps("shell.timer.focus")}
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
    // Named by what it shows (brand, site), then where it leads: the spoken name starts with the visible one.
    <Link
      to="/"
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
      <span className="sr-only">{t("ui.layout.homeLink")}</span>
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

// One row for both widths: the icon keeps its place while the width
// animates, the label only shows open. Nothing moves on toggling.
const ROW =
  "relative flex h-8 w-full shrink-0 items-center gap-3 [@media(max-height:820px)]:h-7 rounded-md pl-[21px] pr-2 text-body-sm font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const ICON = "h-[18px] w-[18px] shrink-0";
/** The sidebar's quick actions in its foot, the toggle last. */
const SIDEBAR_QUICK: ReadonlySet<string> = new Set(["shell.theme", "shell.screensaver", "shell.sync", "shell.sidebar"]);
const labelClass = (collapsed: boolean) => cn("min-w-0 truncate", collapsed && "sr-only");

/** A count beside a row: a number open, a dot on the icon closed. */
/** A section's count: news in the accent; `quiet` a plain tally (the Desk's panes), not shown on the rail. */
function CountChip({ count, collapsed, title, sr, quiet = false }: { count: number; collapsed: boolean; title?: string; sr?: string; quiet?: boolean }) {
  if (quiet && collapsed) return null;
  return (
    <span
      title={title}
      {...surface("chip")}
      className={cn(
        "rounded-full text-2xs font-semibold tabular",
        quiet ? "bg-muted text-muted-foreground" : "bg-primary-soft text-primary-strong",
        collapsed ? "absolute left-[34px] top-1 h-2 w-2 bg-primary-strong" : "ml-auto px-1.5 py-px"
      )}
    >
      <span className={cn(collapsed && "sr-only")}>
        {count}
        {sr && <span className="sr-only">{sr}</span>}
      </span>
    </span>
  );
}

/** The sidebar's daily destinations, drawn as rows; every other entry is a tile. */
const DAILY_ROUTES: ReadonlySet<string> = new Set(["/", "/board", "/issues", "/issues/desk", "/timesheet"]);

/**
 * An entry as a tile: open, its icon over its name (two short lines at most); closed, an icon tile with
 * its name as a tooltip. Current like a row: the primary's soft tint. A count is a badge in its corner.
 */
const NavTile = memo(function NavTile({ to, name, Icon, collapsed, count, countTitle, countSr }: {
  to: string;
  name: string;
  Icon: LucideIcon;
  collapsed: boolean;
  count: number | null;
  countTitle?: string;
  countSr?: string;
}) {
  return (
    <RailTip collapsed={collapsed} label={name}>
      <NavLink
        to={to}
        aria-label={collapsed ? name : undefined}
        {...surface("nav", { current: true, edge: false })}
        {...(routeControlId(to) ? flowControlProps(routeControlId(to)!) : {})}
        className={cn(
          "relative flex flex-col items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-strong",
          // Closed: a 28 px icon (WCAG's 24 px met as it is; a wider area would cover its neighbour).
          collapsed ? "size-7" : "min-h-12 gap-1 px-1 py-1.5"
        )}
      >
        <Icon className={collapsed ? "h-4 w-4" : ICON} aria-hidden />
        {/* Three columns leave room for every name's longest word ("Impostazioni"): it breaks between words,
            and inside one only as the last resort. */}
        <span className={collapsed ? "sr-only" : "line-clamp-2 w-full text-center text-2xs font-medium leading-tight [overflow-wrap:anywhere]"}>{name}</span>
        {count !== null && (
          <span
            title={countTitle}
            {...surface("chip")}
            className={cn(
              "absolute rounded-full bg-primary-soft text-2xs font-semibold text-primary-strong tabular",
              collapsed ? "right-0 top-0 h-2 w-2 bg-primary-strong" : "right-1 top-1 px-1 leading-4"
            )}
          >
            <span className={cn(collapsed && "sr-only")}>{count}</span>
            {countSr && <span className="sr-only">{countSr}</span>}
          </span>
        )}
      </NavLink>
    </RailTip>
  );
});

/**
 * A section of the menu: drawn again only when its own count or the width
 * changes (the sidebar itself redraws with every sync tick and count).
 */
const NavRow = memo(function NavRow({ to, name, Icon, collapsed, padForPin, count, countTitle, countSr, countQuiet, end = to === "/" }: {
  to: string;
  name: string;
  Icon: LucideIcon;
  collapsed: boolean;
  padForPin: boolean;
  count: number | null;
  countTitle?: string;
  countSr?: string;
  countQuiet?: boolean;
  /** Current only on its own path, not on the pages under it. */
  end?: boolean;
}) {
  return (
    <RailTip collapsed={collapsed} label={name}>
      {/* Static classes (aria-current) so Tooltip's asChild merge keeps them. */}
      <NavLink
        to={to}
        end={end}
        aria-label={collapsed ? name : undefined}
        // Stands out only while current; keeps its own ::before bar.
        {...surface("nav", { current: true, edge: false })}
        {...(routeControlId(to) ? flowControlProps(routeControlId(to)!) : {})}
        className={cn(
          ROW,
          "aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-strong",
          "before:absolute before:-left-2 before:inset-y-2 before:w-1 before:rounded-r-full before:bg-primary before:opacity-0 aria-[current=page]:before:opacity-100",
          padForPin && "pr-9"
        )}
      >
        <Icon className={ICON} aria-hidden />
        <span className={labelClass(collapsed)}>{name}</span>
        {count !== null && <CountChip count={count} collapsed={collapsed} title={countTitle} sr={countSr} quiet={countQuiet} />}
      </NavLink>
    </RailTip>
  );
});

/**
 * The foot's "Now": the timer card (every control, two lines) when a timer is shown, and always the way to
 * start one, its last line. Its own component: only it follows the timers (the sidebar does not redraw on
 * every tick). Closed, the ring opens the same card as a player beside the rail.
 */
function SidebarNow({ collapsed, timerPlaced, start }: { collapsed: boolean; timerPlaced: boolean; start: React.ReactNode }) {
  const { timers } = useTimers();
  const shown = timerPlaced && timers.length > 0;
  if (!shown && !start) return null;
  if (collapsed)
    return (
      <div className="flex flex-col gap-0.5">
        {shown && (
          <FlowControlHost.Provider value="shell.timer.active">
            <div data-workspace-area="shell.timer" data-workspace-anchor="shell.timer.active">
              <ActiveTimerRailPlayer extra={<ActiveTimerFocusButton />} />
            </div>
          </FlowControlHost.Provider>
        )}
        {start}
      </div>
    );
  return (
    <div {...surface("card")} className="grid grid-cols-[minmax(0,1fr)] gap-0.5 rounded-xl border bg-card p-1">
      {shown ? (
        <FlowControlHost.Provider value="shell.timer.active">
          <div data-workspace-area="shell.timer" data-workspace-anchor="shell.timer.active" className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
            {/* Pause and stop by the time; move, discard and focus by the note. */}
            <div className="flex min-w-0 items-center gap-0.5">
              <ActiveTimerChip className="min-w-0 flex-1 border-0 bg-transparent px-2" />
              <ActiveTimerQuickControls compact part="main" />
            </div>
            <div className="flex min-w-0 items-center gap-0.5 border-t pt-0.5">
              <ActiveTimerNote className="min-w-0 flex-1" />
              <ActiveTimerQuickControls part="more" />
              <ActiveTimerFocusButton />
            </div>
          </div>
        </FlowControlHost.Provider>
      ) : (
        // A TODO being worked on with no timer: its chip, above the way to start one.
        <ActiveTimerChip className="min-w-0 border-0 bg-transparent px-2" />
      )}
      {start && <div className={cn(shown && "border-t pt-0.5")}>{start}</div>}
    </div>
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
  // The Desk's panes, only once the desk was read (it never adds a request to a page).
  const desk = trpc.desks.current.useQuery(undefined, { enabled: false }).data;
  const onDesk = desk ? desk.panes.filter(slot => !("empty" in slot)).length + desk.parked.length : 0;
  // The count beside a section: issues with news, TODOs due today or late, issues on the desk.
  const chipOf = (to: string) =>
    to === "/issues" && unread > 0
      ? { count: unread, title: t("ui.layout.issuesWithNews", { count: unread }), sr: t("ui.layout.withNews") }
      : to === "/todos" && due > 0
        ? { count: due, title: t("ui.layout.todosDue", { count: due }), sr: t("ui.layout.forToday") }
        : to === "/issues/desk" && onDesk > 0
          ? { count: onDesk, title: t("pages.desk.count", { count: onDesk }), sr: undefined, quiet: true }
          : null;
  const pinboard = usePinboardPanel();
  const { workspace } = useWorkspace();
  const placementsIn = (areaId: string) => placementsFor(workspace, areaId);
  const navigationPlacements = placementsIn("shell.navigation");
  const isVisible = (anchorId: string, areaId: string) => isPlaced(workspace, anchorId, areaId);
  const navItems = useNavItems();
  // The Board's pin button opens the Board's own panel there; "p" the widget first.
  const pinTarget = usePinboardTarget(pathname, true);

  const row = ROW;
  const label = labelClass(collapsed);
  const icon = ICON;
  const anchorOrder = (anchorId: string) => navigationPlacements.find(placement => placement.anchorId === anchorId)?.order ?? Number.MAX_SAFE_INTEGER;
  // Every entry in its order (TODO and Pinboard only where the layout puts them in the navigation).
  const inlineAccessory = (to: string) => {
    const anchorId = to === "/pinboard" ? "shell.pinboard" : "shell.todos";
    return isVisible(anchorId, "shell.navigation") && anchorOrder(anchorId) >= anchorOrder("shell.navigation");
  };
  const entries = navItems.flatMap(({ items }) => {
    const accessories = items.filter(item => item.to === "/pinboard" || item.to === "/todos").sort((a, b) => anchorOrder(a.to === "/pinboard" ? "shell.pinboard" : "shell.todos") - anchorOrder(b.to === "/pinboard" ? "shell.pinboard" : "shell.todos"));
    return items
      .map(item => (item.to === "/pinboard" || item.to === "/todos" ? accessories.shift()! : item))
      .filter(item => (item.to !== "/pinboard" && item.to !== "/todos") || inlineAccessory(item.to));
  });
  const daily = entries.filter(item => DAILY_ROUTES.has(item.to));
  // Every entry stays inside the navigation block: FlowMap measures a click on the block it is drawn in.
  const tools = entries.filter(item => !DAILY_ROUTES.has(item.to));
  const renderRow = ({ to, label: name, icon: Icon }: (typeof entries)[number]) => {
    const chip = chipOf(to);
    const link = (
      <NavRow
        key={to}
        to={to}
        name={name}
        Icon={Icon}
        collapsed={collapsed}
        padForPin={to === "/board" && !collapsed}
        count={chip?.count ?? null}
        countTitle={chip?.title}
        countSr={chip?.sr}
        countQuiet={chip?.quiet}
        // The Desk lives under Issues but is its own entry: Issues is not current there.
        end={to === "/" || (to === "/issues" && pathname.startsWith("/issues/desk"))}
      />
    );
    if (to === "/issues/desk") return <DeskDropTarget key={to}>{link}</DeskDropTarget>;
    if (to !== "/board" || collapsed || pinTarget === null || pinTarget === "page" || !isVisible("shell.pinboard", "shell.navigation")) return link;
    // The pinboard, one tap away from any page: a sibling of the link, never inside it.
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
          {...flowControlProps("shell.pinboard.toggle")}
          className={cn(
            "absolute right-1.5 top-1/2 flex size-target -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-primary-strong focus-visible:ring-2 focus-visible:ring-ring",
            panelOpen && "text-primary-strong"
          )}
        >
          <Pin className="h-3.5 w-3.5 -rotate-12" aria-hidden />
        </button>
      </div>
    );
  };
  const navigation = (
    <nav
      aria-label={t("ui.layout.mainNav")}
      data-workspace-anchor="shell.navigation"
      // The sections never scroll: only the favorites below them do. After search and notifications,
      // the sidebar's own gap-3 apart from them (the area's rows sit at gap-0.5).
      className={cn("flex shrink-0 flex-col gap-1.5", navigationPlacements[0]?.anchorId !== "shell.navigation" && "mt-2.5")}
    >
      {/* Where the day is spent, as rows (read at a glance); the rest as tiles: open a 3-column grid with
          icon and name (whole names, Italian included), closed a 2-column block of icons, the same order. */}
      {daily.length > 0 && (
        <div role="group" aria-label={navItems[0]?.title} className="flex shrink-0 flex-col gap-0.5">
          <div aria-hidden className="mx-2 mb-1 border-t" />
          {daily.map(renderRow)}
        </div>
      )}
      {tools.length > 0 && (
        <div role="group" aria-label={t("ui.layout.toolsNav")} className="shrink-0">
          <div aria-hidden className="mx-2 mb-2 border-t" />
          <div className={cn("grid", collapsed ? "mx-auto w-fit grid-cols-2 gap-0.5" : "grid-cols-3 gap-1")}>
            {tools.map(({ to, label: name, icon: Icon }) => {
              const chip = chipOf(to);
              return <NavTile key={to} to={to} name={name} Icon={Icon} collapsed={collapsed} count={chip?.count ?? null} countTitle={chip?.title} countSr={chip?.sr} />;
            })}
          </div>
        </div>
      )}
    </nav>
  );
  const renderShellAnchor = (anchorId: string) => {
    let content: React.ReactNode = null;
    if (anchorId === "shell.navigation") content = navigation;
    else if (anchorId === "shell.search") content = (
      <RailTip collapsed={collapsed} label={t("ui.layout.searchTip", { shortcut: PALETTE_SHORTCUT })}>
        <button type="button" onClick={() => commandPalette.set(true)} aria-label={collapsed ? t("ui.layout.search") : undefined} {...surface("control")} {...flowControlProps("shell.search.open")} className={cn(row, "mb-1 border border-border/80 bg-background pl-5 font-normal hover:bg-background")}>
          <Search className={icon} aria-hidden /><span className={label}>{t("ui.layout.searchEllipsis")}</span>{!collapsed && <Kbd className="ml-auto">{PALETTE_SHORTCUT}</Kbd>}
        </button>
      </RailTip>
    );
    else if (anchorId === "shell.notifications") content = (
      <RailTip collapsed={collapsed} label={t("ui.layout.notificationsTip")}>
        <button type="button" onClick={() => notificationCenter.set(true)} {...flowControlProps("shell.notifications.open")} aria-label={collapsed || inbox > 0 ? inbox > 0 ? t("ui.layout.notificationsUnseen", { count: inbox }) : t("ui.layout.notifications") : undefined} className={row}>
          <Bell className={icon} aria-hidden /><span className={label}>{t("ui.layout.notifications")}</span>{inbox > 0 && <span aria-hidden><CountChip count={inbox} collapsed={collapsed} /></span>}
        </button>
      </RailTip>
    );
    else if (anchorId === "shell.pinboard" && (isVisible(anchorId, "shell.overlays") || anchorOrder(anchorId) < anchorOrder("shell.navigation"))) content = (
      <RailTip collapsed={collapsed} label={t("ui.layout.openPinboard")}>
        <button type="button" onClick={() => togglePinboard(pathname, true)} {...flowControlProps("shell.pinboard.toggle")} className={row}>
          <Pin className={icon} aria-hidden /><span className={label}>{t("ui.layout.openPinboard")}</span>
        </button>
      </RailTip>
    );
    else if (anchorId === "shell.todos" && (isVisible(anchorId, "shell.overlays") || anchorOrder(anchorId) < anchorOrder("shell.navigation"))) content = (
      <RailTip collapsed={collapsed} label={t("ui.todoFloat.open")}>
        <button type="button" onClick={openTodosSheet} {...flowControlProps("shell.todos.open")} className={row}>
          <ListChecks className={icon} aria-hidden /><span className={label}>{t("ui.todoFloat.open")}</span>
        </button>
      </RailTip>
    );
    else if (anchorId === "shell.screensaver") content = (
      <RailTip collapsed={collapsed} label={t("ui.layout.screensaverTip")}>
        <button type="button" onClick={() => screensaver.set(true)} {...flowControlProps("shell.screensaver.open")} aria-label={collapsed ? t("ui.layout.screensaver") : undefined} className={row}>
          <Sparkles className={icon} strokeWidth={1.75} aria-hidden /><span className={label}>{t("ui.layout.screensaver")}</span>{!collapsed && <Kbd className="ml-auto font-normal text-muted-foreground">Z</Kbd>}
        </button>
      </RailTip>
    );
    return content ? <div className="contents" data-workspace-anchor={anchorId}>{content}</div> : null;
  };
  const actionPlacements = placementsIn("shell.actions");
  const placedRow = (anchorId: string) => actionPlacements.some(placement => placement.anchorId === anchorId);
  /**
   * Theme, screensaver and sync as quick tiles in the foot, with the sidebar's toggle last: one row open, a
   * 2×2 block closed. Same order and same place in both states; the toggle is always the last control.
   */
  const quickPlacements = actionPlacements.filter(placement => SIDEBAR_QUICK.has(placement.anchorId));
  const QUICK = cn(
    "relative flex items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
    // Open: a finger's 44 px on touch screens, the look unchanged, with room between the tiles so no
    // tile's area covers its neighbour. Closed (the 2×2 block), the 28 px tiles meet WCAG's 24 px as they are.
    !collapsed && "coarse:after:absolute coarse:after:left-1/2 coarse:after:top-1/2 coarse:after:size-touch coarse:after:-translate-x-1/2 coarse:after:-translate-y-1/2 coarse:after:content-['']",
    collapsed ? "size-7" : "size-8"
  );
  const quick = (anchorId: string) => {
    let content: React.ReactNode = null;
    if (anchorId === "shell.theme") content = (
      <button type="button" role="switch" aria-checked={resolvedTheme === "dark"} aria-label={t("ui.layout.darkTheme")} title={t("ui.layout.darkTheme")} onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} {...flowControlProps("shell.theme.toggle")} className={cn(QUICK, resolvedTheme === "dark" && "text-primary-strong")}>
        <Moon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </button>
    );
    else if (anchorId === "shell.screensaver") content = (
      <button type="button" onClick={() => screensaver.set(true)} {...flowControlProps("shell.screensaver.open")} aria-label={t("ui.layout.screensaver")} title={t("ui.layout.screensaverTip")} className={QUICK}>
        <Sparkles className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </button>
    );
    else if (anchorId === "shell.sync") content = (
      <button type="button" onClick={() => sync.mutate()} {...flowControlProps("shell.sync.start")} disabled={sync.isPending} aria-label={t("ui.layout.syncJira", { provider })} title={[sync.isPending ? t("ui.layout.syncing") : t("ui.layout.syncJira", { provider }), syncError ?? syncHint].filter(Boolean).join(" · ")} className={QUICK}>
        <RefreshCw className={cn("h-4 w-4", sync.isPending && "motion-safe:animate-spin")} aria-hidden />
        {syncError && !sync.isPending && <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warning" />}
      </button>
    );
    else if (anchorId === "shell.sidebar") content = (
      <button type="button" onClick={sidebar.toggle} {...flowControlProps("shell.sidebar.toggle")} aria-label={collapsed ? t("ui.layout.expand") : t("ui.layout.collapse")} title={collapsed ? t("ui.layout.expandTip") : `${t("ui.layout.collapse")} ([)`} className={QUICK}>
        {collapsed ? <ChevronsRight className="h-4 w-4" aria-hidden /> : <ChevronsLeft className="h-4 w-4" aria-hidden />}
      </button>
    );
    return content ? <div className="contents" key={anchorId} data-workspace-anchor={anchorId}>{content}</div> : null;
  };
  const services = quickPlacements.filter(placement => placement.anchorId !== "shell.sidebar").map(placement => quick(placement.anchorId));
  const toggleTile = placedRow("shell.sidebar") ? quick("shell.sidebar") : null;
  const renderActionAnchor = (anchorId: string) => {
    if (anchorId === "shell.screensaver") return renderShellAnchor(anchorId);
    let content: React.ReactNode = null;
    if (anchorId === "shell.quick-start") content = (
      <RailTip collapsed={collapsed} label={t("ui.layout.startTimerTip")}>
        <button type="button" onClick={() => quickStart.set(true)} {...flowControlProps("shell.quickStart.open")} aria-label={collapsed ? t("ui.layout.startTimer") : undefined} className={cn(row, "text-foreground")}>
          <Play className={icon} aria-hidden /><span className={label}>{t("ui.layout.startTimer")}</span>{!collapsed && <Kbd className="ml-auto font-normal text-muted-foreground">T</Kbd>}
        </button>
      </RailTip>
    );
    else if (anchorId === "shell.account") content = <AccountMenu collapsed={collapsed} side={collapsed ? "right" : "top"} settings controls={{ open: flowControlProps("shell.account.open"), settings: flowControlProps("shell.account.settings"), logout: flowControlProps("shell.account.logout") }} />;
    return content ? <div className="contents" data-workspace-anchor={anchorId}>{content}</div> : null;
  };

  return (
    <div
      className={cn(
        // A screen too short even for the fixed rows scrolls the whole column: no row is ever cut.
        // A short laptop (≤ 820 px high): tighter rows and gaps, so the column still fits.
        "flex h-full flex-col gap-3 overflow-y-auto overscroll-contain py-4 [scrollbar-width:thin] [@media(max-height:820px)]:gap-2 [@media(max-height:820px)]:py-3",
        // Room for the shadows of what it holds (the Shadow mod's reach), the same open and closed.
        "pl-[max(0.5rem,var(--surface-reach-l,0px))] pr-[max(0.5rem,var(--surface-reach-r,0px))]"
      )}
    >
      <Brand collapsed={collapsed} />

      <div className="flex shrink-0 flex-col gap-0.5" data-workspace-area="shell.navigation">
        {navigationPlacements.map(placement => <div className="contents" key={placement.anchorId}>{renderShellAnchor(placement.anchorId)}</div>)}
      </div>

      {/* What is left between the sections and the foot: the favorites, scrolling on their own. */}
      {/* Clipped: short of room it shrinks to its title and never draws over the actions. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&:has(*)]:min-h-target">{!collapsed && <SidebarFavorites />}</div>

      {collapsed ? (
        <ModuleSlot id="sidebar-rail" frame={boxes => <div className="flex shrink-0 flex-col items-center gap-1 pb-2">{boxes}</div>} />
      ) : (
        <ModuleSlot id="sidebar-footer" />
      )}
      {/* The foot, the same order open and closed: "Now" (the timer, or Start timer when none runs), then
          under a hairline the account, then the quick tiles with the sidebar's toggle last. */}
      <div className="flex shrink-0 flex-col gap-2" data-workspace-area="shell.actions">
        <SidebarNow
          collapsed={collapsed}
          timerPlaced={isVisible("shell.timer.active", "shell.timer")}
          start={placedRow("shell.quick-start") ? renderActionAnchor("shell.quick-start") : null}
        />
        <div className="grid gap-1 border-t pt-2">
          {placedRow("shell.account") && renderActionAnchor("shell.account")}
          {(services.length > 0 || toggleTile) && (
            // Theme, screensaver, sync, then the toggle: one row open; closed a 2×2 block, the toggle last.
            <div className={cn(collapsed ? "mx-auto grid grid-cols-2 gap-0.5" : "flex items-center gap-0.5 pl-1.5 coarse:gap-3.5")}>
              {services}
              {!collapsed && <span className="flex-1" />}
              {toggleTile}
            </div>
          )}
        </div>
      </div>
      {placementsIn("shell.overlays").length > 0 && <div className="flex shrink-0 flex-col gap-0.5" data-workspace-area="shell.overlays">
        {placementsIn("shell.overlays").map(placement => <div className="contents" key={placement.anchorId}>{renderShellAnchor(placement.anchorId)}</div>)}
      </div>}
    </div>
  );
}

/** Mobile header: opens the notification center, with a dot when there is news. */
/** The phone's way to the TODO list, beside the bell: how many are due today or late, and the list as a sheet. */
function MobileTodos() {
  const due = useTodoReminders().items.length;
  const { pathname } = useLocation();
  const s = useTodoSurfacesNow();
  const { workspace } = useWorkspace();
  if (!isPlaced(workspace, "mobile.todos", "mobile.more") || !(s.menu || s.widget) || pathname === "/todos") return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative shrink-0"
      aria-label={due > 0 ? t("ui.layout.todosDue", { count: due }) : t("ui.todoFloat.open")}
      {...flowControlProps("mobile.todos.open")}
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
  const { workspace } = useWorkspace();
  if (!isPlaced(workspace, "mobile.notifications", "mobile.more")) return null;
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
      {...flowControlProps("mobile.notifications.open")}
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
  const phoneHeader = useRef<HTMLElement>(null);
  // The phone's top bar joins the root's scroll padding (it stays while the window scrolls).
  usePublishChromeHeight(phoneHeader, "app-header");
  useHotkeys();
  useOpenBeside();
  useCommandPaletteShortcut();
  usePinboardWiring();
  useShadowReach();
  useTodoWiring();
  useMouseHistoryButtons(isNative());
  useThemeSync();
  useSoftKeyboard();
  const collapsed = useSidebarCollapsed();
  const location = useLocation();
  // One page, one key: the settings' categories are frames of one page (only the frame changes).
  const pageKey = location.pathname.startsWith("/settings")
    ? "/settings"
    : location.pathname.startsWith("/notes")
      ? "/notes"
      : location.pathname;
  const queryClient = useQueryClient();
  const mainRef = useRef<HTMLElement>(null);
  // A new page starts at the top; Back/Forward land where you were.
  useScrollRestoration(mainRef);
  useNavHistoryRecorder();

  return (
    <TooltipProvider delayDuration={200}>
      <ShellWatchers />
      <WorkspaceScopeProvider scope={{ surfaceId: "shell-desktop", deviceClass: "desktop" }}>
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
        <header ref={phoneHeader} {...surface("glass")} className="safe-top sticky top-0 z-30 flex items-center gap-4 border-b bg-canvas/90 px-3 py-1.5 backdrop-blur lg:hidden">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-lg py-1 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BrandMark className="h-8 w-8" />
            <span className="font-display font-semibold">{BRAND_SHORT}</span>
            <span className="sr-only">{t("ui.layout.homeLink")}</span>
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
          <WorkspaceScopeProvider scope={{ surfaceId: "mobile-tabs", deviceClass: "mobile" }} telemetry={false}>
            <MobileTodos />
            <MobileBell />
          </WorkspaceScopeProvider>
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
        <PinMailHost />
        <WorkspaceInteractionBoundary>
          {/* Logging time from anywhere: typing there holds a layout change back (T-01). */}
          <QuickStart />
          <IdleDialog />
        </WorkspaceInteractionBoundary>
        <DayReview />
        <FocusMode />
        <Screensaver />
        <LiveTitle />
        <ShortcutsDialog />
        <WorkspaceInteractionBoundary><TimerLogHost /></WorkspaceInteractionBoundary>
        <NotificationCenter />
        <PinboardWidget />
        <TodoWidget />
        <MakeTodoHost />
        <HotCorner />
        <StartChoiceDialog />
        <CreateIssueDialog />
        <IdeaCaptureDialog />
        <IssueHistoryDialog />
        <ModuleSettingsSheet />
      </div>
      </ModulesProvider>
      </WorkspaceScopeProvider>
    </TooltipProvider>
  );
}
