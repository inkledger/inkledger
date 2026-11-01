import { orderCatalogManifest } from "./catalog";
import type {
  AccessibilityContract,
  AnchorManifest,
  AreaManifest,
  CatalogManifest,
  ControlDefinition,
  ControlInteraction,
  ControlKind,
  ScopeDefaults,
} from "./catalogTypes";
import type { ProductMigration, StatePolicy, SurfaceId } from "./model";

function area(
  id: string,
  surfaceId: SurfaceId,
  role: AreaManifest["role"],
  capacity: number,
  allowedAnchorIds: readonly string[],
  introducedIn = "1.0.0",
): AreaManifest {
  return { id, surfaceId, role, capacity, allowedAnchorIds, introducedIn };
}

function anchor(
  id: string,
  surfaceId: SurfaceId,
  renderer: string,
  statePolicy: StatePolicy,
  labelKey: string,
  critical = false,
  introducedIn = "1.0.0",
): AnchorManifest {
  const operations = critical || statePolicy === "dirty"
    ? ["variant"] as const
    : statePolicy === "local"
      ? ["reorder", "variant", "pin"] as const
      : ["move", "reorder", "variant", "hide", "pin"] as const;
  return {
    id,
    surfaceId,
    renderer,
    statePolicy,
    critical,
    introducedIn,
    semanticRevision: 1,
    studio: {
      operations,
      variants: ["compact", "default", "expanded"],
      descriptionKey: labelKey,
    },
    accessibility: {
      role: "region",
      labelKey,
      keyboard: "not-applicable",
      minTouchTargetPx: 24,
    },
  };
}

function control(
  id: string,
  anchorId: string,
  labelKey: string,
  options: {
    kind?: ControlKind;
    role?: AccessibilityContract["role"];
    keyboard?: AccessibilityContract["keyboard"];
    minTouchTargetPx?: AccessibilityContract["minTouchTargetPx"];
    critical?: boolean;
    sensitive?: boolean;
    telemetry?: ControlInteraction["telemetry"];
    introducedIn?: string;
    semanticRevision?: number;
    outcome?: boolean;
  } = {},
): ControlDefinition {
  const kind = options.kind ?? "command";
  const telemetry = options.telemetry ?? "allowed";
  const interactions: ControlInteraction[] = [
    { eventId: `${id}.${kind === "navigation" ? "navigate" : "activate"}`, kind: kind === "navigation" ? "navigate" : "activate", telemetry },
  ];
  if (options.outcome) {
    interactions.push(
      { eventId: `${id}.succeed`, kind: "succeed", telemetry },
      { eventId: `${id}.fail`, kind: "fail", telemetry },
    );
  }
  return {
    id,
    anchorId,
    kind,
    critical: options.critical ?? false,
    sensitive: options.sensitive ?? false,
    introducedIn: options.introducedIn ?? "1.0.0",
    semanticRevision: options.semanticRevision ?? 1,
    accessibility: {
      role: options.role ?? "button",
      labelKey,
      keyboard: options.keyboard ?? "activation",
      minTouchTargetPx: options.minTouchTargetPx ?? 24,
    },
    interactions,
  };
}

/** A local-state anchor the user could always hide from Customize (the old Dashboard layout). */
function hideable(manifest: AnchorManifest): AnchorManifest {
  return { ...manifest, studio: { ...manifest.studio, operations: [...manifest.studio.operations, "hide"] } };
}

const anchors: AnchorManifest[] = [
  hideable(anchor("dashboard.timeline", "dashboard", "DayTimeline", "local", "pages.dashboard.widgets.timeline")),
  anchor("dashboard.stats", "dashboard", "QuickStatsCard", "stateless", "pages.dashboard.widgets.stats"),
  hideable(anchor("dashboard.summary", "dashboard", "PeriodSummary", "local", "pages.dashboard.widgets.summary")),
  anchor("dashboard.tasks", "dashboard", "TasksBoard", "external", "pages.dashboard.widgets.tasks"),
  anchor("dashboard.activity", "dashboard", "ActivityTable", "stateless", "pages.dashboard.widgets.activity"),
  anchor("dashboard.recap", "dashboard", "WeekRecapCard", "stateless", "pages.dashboard.widgets.recap"),
  anchor("dashboard.desk", "dashboard", "ModuleSlot", "external", "pages.dashboard.desk"),
  anchor("dashboard.period", "dashboard", "PeriodNav", "local", "pages.dashboard.period"),
  // Pause, resume and stop live here: as critical as the shell timer (C-01), never hidden or moved.
  anchor("dashboard.headerTimer", "dashboard", "HeaderTimer", "external", "ui.timer.active", true),
  anchor("dashboard.quickActions", "dashboard", "DashboardQuickActions", "external", "pages.dashboard.logTime"),
  anchor("dashboard.customize", "dashboard", "DashboardCustomize", "stateless", "pages.dashboard.customize"),
  anchor("dashboard.quick-log", "dashboard", "QuickLog", "dirty", "pages.dashboard.logTime"),
  anchor("dashboard.planned-dialog", "dashboard", "PlannedDialog", "dirty", "ui.planned.plan"),
  anchor("dashboard.gap-cutter", "dashboard", "GapCutter", "dirty", "views.dashboard.gap.title"),
  anchor("shell.navigation", "shell-desktop", "SidebarNavigation", "stateless", "ui.layout.mainNav"),
  anchor("shell.search", "shell-desktop", "CommandPalette", "external", "ui.layout.search"),
  anchor("shell.notifications", "shell-desktop", "NotificationCenter", "external", "ui.layout.notifications"),
  anchor("shell.pinboard", "shell-desktop", "PinboardWidget", "external", "ui.layout.openPinboard"),
  anchor("shell.todos", "shell-desktop", "TodoWidget", "external", "ui.todoFloat.open"),
  anchor("shell.theme", "shell-desktop", "ThemeToggle", "external", "ui.layout.darkTheme"),
  anchor("shell.screensaver", "shell-desktop", "Screensaver", "external", "ui.layout.screensaver"),
  anchor("shell.timer.active", "shell-desktop", "TimerControls", "critical", "ui.timer.active", true),
  anchor("shell.quick-start", "shell-desktop", "QuickStart", "external", "ui.layout.startTimer"),
  anchor("shell.sync", "shell-desktop", "SyncButton", "external", "ui.layout.syncJira"),
  anchor("shell.account", "shell-desktop", "AccountMenu", "local", "ui.layout.accountMenu"),
  anchor("shell.sidebar", "shell-desktop", "SidebarToggle", "local", "ui.layout.collapse"),
  anchor("mobile.home", "mobile-tabs", "MobileHomeTab", "local", "ui.nav.dashboard"),
  anchor("mobile.board", "mobile-tabs", "MobileBoardTab", "local", "ui.nav.board"),
  anchor("mobile.issues", "mobile-tabs", "MobileIssuesTab", "local", "ui.nav.issues"),
  anchor("mobile.timer.active", "mobile-tabs", "MobileTimerSheet", "critical", "ui.timer.active", true),
  anchor("mobile.more", "mobile-tabs", "MobileMoreSheet", "local", "ui.layout.more"),
  anchor("mobile.todos", "mobile-tabs", "MobileTodos", "external", "ui.todoFloat.open"),
  anchor("mobile.notifications", "mobile-tabs", "MobileBell", "external", "ui.layout.notifications"),
  anchor("mobile.dock", "mobile-tabs", "ModuleDock", "external", "ui.layout.moduleDock"),
];

const dashboardAreas = [
  area("dashboard.header", "dashboard", "actions", 6, ["dashboard.period", "dashboard.headerTimer", "dashboard.quickActions", "dashboard.customize"]),
  area("dashboard.primary", "dashboard", "primary", 5, ["dashboard.timeline", "dashboard.summary", "dashboard.tasks", "dashboard.activity", "dashboard.recap"]),
  area("dashboard.secondary", "dashboard", "secondary", 2, ["dashboard.stats", "dashboard.summary", "dashboard.activity"]),
  area("dashboard.desk", "dashboard", "secondary", 4, ["dashboard.desk"]),
  area("dashboard.overlays", "dashboard", "overlay", 3, ["dashboard.quick-log", "dashboard.planned-dialog", "dashboard.gap-cutter"]),
];

const shellAreas = [
  area("shell.navigation", "shell-desktop", "navigation", 12, ["shell.navigation", "shell.search", "shell.notifications", "shell.pinboard", "shell.todos"]),
  area("shell.actions", "shell-desktop", "actions", 8, ["shell.theme", "shell.screensaver", "shell.quick-start", "shell.sync", "shell.account", "shell.sidebar"]),
  area("shell.timer", "shell-desktop", "dock", 3, ["shell.timer.active"]),
  area("shell.overlays", "shell-desktop", "overlay", 4, ["shell.search", "shell.notifications", "shell.pinboard", "shell.todos", "shell.screensaver"]),
];

const mobileAreas = [
  area("mobile.tabs", "mobile-tabs", "navigation", 5, ["mobile.home", "mobile.board", "mobile.issues", "mobile.timer.active", "mobile.more"]),
  area("mobile.more", "mobile-tabs", "secondary", 12, ["mobile.more", "mobile.todos", "mobile.notifications", "mobile.dock"]),
  area("mobile.dock", "mobile-tabs", "dock", 2, ["mobile.dock"]),
];

const controls: ControlDefinition[] = [
  control("dashboard.period.day", "dashboard.period", "pages.dashboard.periodDay", { kind: "toggle", role: "radio" }),
  control("dashboard.period.week", "dashboard.period", "pages.dashboard.periodWeek", { kind: "toggle", role: "radio" }),
  control("dashboard.period.month", "dashboard.period", "pages.dashboard.periodMonth", { kind: "toggle", role: "radio" }),
  control("dashboard.period.previous", "dashboard.period", "ui.period.prev"),
  control("dashboard.period.next", "dashboard.period", "ui.period.next"),
  control("dashboard.period.today", "dashboard.period", "common.today"),
  control("dashboard.period.pickDate", "dashboard.period", "pages.dashboard.pickDate"),
  control("dashboard.logTime", "dashboard.quickActions", "pages.dashboard.logTime", { kind: "mutation", outcome: true }),
  control("dashboard.plan", "dashboard.quickActions", "ui.planned.plan", { kind: "mutation", outcome: true }),
  control("dashboard.closeDay", "dashboard.quickActions", "pages.dashboard.closeDay", { kind: "disclosure" }),
  control("dashboard.customize.open", "dashboard.customize", "pages.dashboard.customize", { kind: "disclosure" }),
  control("dashboard.customize.toggle", "dashboard.customize", "pages.dashboard.visibleSections", { kind: "toggle", role: "checkbox" }),
  control("dashboard.timer.pause", "dashboard.headerTimer", "ui.timer.pause", { kind: "mutation", critical: true, outcome: true }),
  control("dashboard.timer.resume", "dashboard.headerTimer", "ui.timer.resume", { kind: "mutation", critical: true, outcome: true }),
  control("dashboard.timer.stop", "dashboard.headerTimer", "ui.timer.stopAndLog", { kind: "mutation", critical: true, outcome: true }),
  control("dashboard.timer.logStopped", "dashboard.headerTimer", "pages.dashboard.toLog", { kind: "mutation", outcome: true }),
  control("dashboard.timeline.gap", "dashboard.timeline", "views.dashboard.gap.title", { kind: "disclosure" }),
  control("dashboard.timeline.pendingLog", "dashboard.timeline", "pages.dashboard.toLog", { kind: "mutation", outcome: true }),
  control("dashboard.timeline.plannedEdit", "dashboard.timeline", "ui.planned.plan", { kind: "disclosure" }),
  control("dashboard.timeline.issueOpen", "dashboard.timeline", "common.open", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("dashboard.tasks.openBoard", "dashboard.tasks", "pages.dashboard.openBoard", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("dashboard.tasks.collapse", "dashboard.tasks", "pages.dashboard.collapseColumn", { kind: "toggle", role: "checkbox" }),
  control("dashboard.tasks.issueOpen", "dashboard.tasks", "common.open", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("dashboard.desk.module", "dashboard.desk", "pages.dashboard.desk", { telemetry: "disabled", sensitive: true }),
  control("dashboard.quickLog.save", "dashboard.quick-log", "pages.dashboard.logTime", { kind: "mutation", outcome: true }),
  control("dashboard.quickLog.input", "dashboard.quick-log", "pages.dashboard.logPick", { kind: "input", role: "textbox", keyboard: "input", sensitive: true, telemetry: "disabled" }),
  control("dashboard.quickLog.cancel", "dashboard.quick-log", "common.cancel"),
  control("dashboard.planned.save", "dashboard.planned-dialog", "ui.planned.plan", { kind: "mutation", outcome: true }),
  control("dashboard.planned.input", "dashboard.planned-dialog", "ui.planned.plan", { kind: "input", role: "textbox", keyboard: "input", sensitive: true, telemetry: "disabled" }),
  control("dashboard.planned.cancel", "dashboard.planned-dialog", "common.cancel"),
  control("dashboard.gapCutter.save", "dashboard.gap-cutter", "views.dashboard.gap.title", { kind: "mutation", outcome: true }),
  control("dashboard.gapCutter.cancel", "dashboard.gap-cutter", "common.cancel"),
  control("shell.nav.home", "shell.navigation", "ui.nav.dashboard", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.board", "shell.navigation", "ui.nav.board", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.pinboard", "shell.navigation", "ui.nav.pinboard", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.todos", "shell.navigation", "ui.nav.todos", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.ideas", "shell.navigation", "ui.nav.ideas", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.issues", "shell.navigation", "ui.nav.issues", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.notes", "shell.navigation", "ui.nav.notes", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.timesheet", "shell.navigation", "ui.nav.timesheet", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.reports", "shell.navigation", "ui.nav.reports", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.settings", "shell.navigation", "ui.nav.settings", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.nav.info", "shell.navigation", "ui.nav.info", { kind: "navigation", role: "link", keyboard: "navigation" }),
  control("shell.search.open", "shell.search", "ui.layout.search", { kind: "disclosure" }),
  control("shell.search.select", "shell.search", "ui.layout.search", { kind: "navigation", role: "menuitem", keyboard: "navigation" }),
  control("shell.notifications.open", "shell.notifications", "ui.layout.notifications", { kind: "disclosure" }),
  control("shell.pinboard.toggle", "shell.pinboard", "ui.layout.openPinboard", { kind: "toggle", role: "checkbox" }),
  control("shell.todos.open", "shell.todos", "ui.todoFloat.open", { kind: "disclosure" }),
  control("shell.theme.toggle", "shell.theme", "ui.layout.darkTheme", { kind: "toggle", role: "switch" }),
  control("shell.screensaver.open", "shell.screensaver", "ui.layout.screensaver", { kind: "disclosure" }),
  control("shell.timer.start", "shell.timer.active", "ui.layout.startTimer", { kind: "mutation", critical: true, outcome: true }),
  control("shell.timer.pause", "shell.timer.active", "ui.timer.pause", { kind: "mutation", critical: true, outcome: true }),
  control("shell.timer.resume", "shell.timer.active", "ui.timer.resume", { kind: "mutation", critical: true, outcome: true }),
  control("shell.timer.stop", "shell.timer.active", "ui.timer.stopAndLog", { kind: "mutation", critical: true, outcome: true }),
  control("shell.timer.focus", "shell.timer.active", "ui.layout.focusMode", { kind: "disclosure", critical: true }),
  control("shell.quickStart.open", "shell.quick-start", "ui.layout.startTimer", { kind: "disclosure" }),
  control("shell.sync.start", "shell.sync", "ui.layout.syncJira", { kind: "mutation", outcome: true }),
  control("shell.account.open", "shell.account", "ui.layout.accountMenu", { kind: "disclosure" }),
  control("shell.account.settings", "shell.account", "ui.nav.settings", { kind: "navigation", role: "menuitem", keyboard: "navigation" }),
  control("shell.account.logout", "shell.account", "ui.layout.logout"),
  control("shell.sidebar.toggle", "shell.sidebar", "ui.layout.collapse", { kind: "toggle", role: "checkbox" }),
  control("mobile.tabs.home", "mobile.home", "ui.nav.dashboard", { kind: "navigation", role: "tab", keyboard: "navigation", minTouchTargetPx: 44 }),
  control("mobile.tabs.board", "mobile.board", "ui.nav.board", { kind: "navigation", role: "tab", keyboard: "navigation", minTouchTargetPx: 44 }),
  control("mobile.tabs.issues", "mobile.issues", "ui.nav.issues", { kind: "navigation", role: "tab", keyboard: "navigation", minTouchTargetPx: 44 }),
  control("mobile.tabs.more", "mobile.more", "ui.layout.more", { kind: "disclosure", role: "tab", minTouchTargetPx: 44 }),
  control("mobile.timer.start", "mobile.timer.active", "ui.layout.startTimer", { kind: "mutation", critical: true, outcome: true, minTouchTargetPx: 44 }),
  control("mobile.timer.open", "mobile.timer.active", "ui.timer.active", { kind: "disclosure", critical: true, minTouchTargetPx: 44 }),
  control("mobile.todos.open", "mobile.todos", "ui.todoFloat.open", { kind: "disclosure", minTouchTargetPx: 44 }),
  control("mobile.notifications.open", "mobile.notifications", "ui.layout.notifications", { kind: "disclosure", minTouchTargetPx: 44 }),
  control("mobile.dock.module", "mobile.dock", "ui.layout.moduleDock", { sensitive: true, telemetry: "disabled", minTouchTargetPx: 44 }),
];

export const CATALOG_V1: CatalogManifest = orderCatalogManifest({
  schemaVersion: 1,
  catalogVersion: "1.0.0",
  productDefaultVersion: "product-1",
  resolverVersion: 1,
  surfaces: [
    { id: "dashboard", route: "/", deviceClasses: ["desktop", "mobile"] },
    { id: "shell-desktop", route: "*", deviceClasses: ["desktop"] },
    { id: "mobile-tabs", route: "*", deviceClasses: ["mobile"] },
  ],
  areas: [...dashboardAreas, ...shellAreas, ...mobileAreas],
  anchors,
  controls,
  rendererBindings: anchors.map(anchor => ({ anchorId: anchor.id, kind: "core", renderer: anchor.renderer })),
  tombstones: [],
});

export const PRODUCT_MIGRATIONS_V1: readonly ProductMigration[] = [];

export const PRODUCT_DEFAULTS_V1: ScopeDefaults = {
  dashboard: {
    productDefaultVersion: "product-1",
    placements: [
      { anchorId: "dashboard.headerTimer", areaId: "dashboard.header", order: 0, visible: true, variant: "default", pinned: true },
      { anchorId: "dashboard.period", areaId: "dashboard.header", order: 1, visible: true, variant: "default", pinned: true },
      { anchorId: "dashboard.quickActions", areaId: "dashboard.header", order: 2, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.customize", areaId: "dashboard.header", order: 3, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.timeline", areaId: "dashboard.primary", order: 0, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.stats", areaId: "dashboard.secondary", order: 0, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.summary", areaId: "dashboard.primary", order: 1, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.tasks", areaId: "dashboard.primary", order: 2, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.activity", areaId: "dashboard.primary", order: 3, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.recap", areaId: "dashboard.primary", order: 4, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.desk", areaId: "dashboard.desk", order: 0, visible: true, variant: "default", pinned: false },
      { anchorId: "dashboard.quick-log", areaId: "dashboard.overlays", order: 0, visible: false, variant: "default", pinned: true },
      { anchorId: "dashboard.planned-dialog", areaId: "dashboard.overlays", order: 1, visible: false, variant: "default", pinned: true },
      { anchorId: "dashboard.gap-cutter", areaId: "dashboard.overlays", order: 2, visible: false, variant: "default", pinned: true },
    ],
  },
  "shell-desktop": {
    productDefaultVersion: "product-1",
    placements: [
      { anchorId: "shell.search", areaId: "shell.navigation", order: 0, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.notifications", areaId: "shell.navigation", order: 1, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.navigation", areaId: "shell.navigation", order: 2, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.pinboard", areaId: "shell.navigation", order: 3, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.todos", areaId: "shell.navigation", order: 4, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.theme", areaId: "shell.actions", order: 0, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.screensaver", areaId: "shell.actions", order: 1, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.timer.active", areaId: "shell.timer", order: 0, visible: true, variant: "default", pinned: true },
      { anchorId: "shell.quick-start", areaId: "shell.actions", order: 2, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.sync", areaId: "shell.actions", order: 3, visible: true, variant: "default", pinned: false },
      { anchorId: "shell.account", areaId: "shell.actions", order: 4, visible: true, variant: "default", pinned: true },
      { anchorId: "shell.sidebar", areaId: "shell.actions", order: 5, visible: true, variant: "default", pinned: true },
    ],
  },
  "mobile-tabs": {
    productDefaultVersion: "product-1",
    placements: [
      { anchorId: "mobile.home", areaId: "mobile.tabs", order: 0, visible: true, variant: "default", pinned: true },
      { anchorId: "mobile.board", areaId: "mobile.tabs", order: 1, visible: true, variant: "default", pinned: true },
      { anchorId: "mobile.timer.active", areaId: "mobile.tabs", order: 2, visible: true, variant: "default", pinned: true },
      { anchorId: "mobile.issues", areaId: "mobile.tabs", order: 3, visible: true, variant: "default", pinned: true },
      { anchorId: "mobile.more", areaId: "mobile.tabs", order: 4, visible: true, variant: "default", pinned: false },
      { anchorId: "mobile.todos", areaId: "mobile.more", order: 1, visible: true, variant: "default", pinned: false },
      { anchorId: "mobile.notifications", areaId: "mobile.more", order: 2, visible: true, variant: "default", pinned: false },
      { anchorId: "mobile.dock", areaId: "mobile.dock", order: 0, visible: true, variant: "default", pinned: false },
    ],
  },
};
