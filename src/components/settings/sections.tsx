import type { ReactNode } from "react";
import { useTheme } from "next-themes";
import {
  Bell,
  DatabaseBackup,
  Link2,
  CalendarClock,
  Palette,
  Pin,
  Server,
  ShieldCheck,
  Store,
  Smartphone,
  Timer,
  UserRound,
  Users,
  Plug,
  Layers,
  Briefcase,
  ListChecks,
  Mail,
  Network,
  Hourglass,
  type LucideIcon,
} from "lucide-react";
import { formatDuration, startOfWeek } from "@contracts/time";
import { scheduleFor } from "@contracts/workSchedule";
import { useAuth } from "@/hooks/useAuth";
import { useDensity } from "@/hooks/useDensity";
import { useNativeInfo } from "@/hooks/useNativeInfo";
import { useNativeProfiles } from "@/hooks/useNativeProfiles";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useToday } from "@/hooks/useToday";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { currentPermission, PERMISSION_LABEL } from "@/lib/browserNotifications";
import { busyLabel, isNative } from "@/lib/native";
import { detectPlatform } from "@/lib/devices";
import { weekSeconds } from "@/lib/weekSeconds";
import { DENSITIES, THEMES } from "@/lib/appearance";
import { AccountSection } from "@/components/settings/sections/Account";
import { AppearanceSection } from "@/components/settings/sections/Appearance";
import { PinboardSection } from "@/components/settings/sections/Pinboard";
import { TodosSection } from "@/components/settings/sections/Todos";
import { EstimatesSection } from "@/components/settings/sections/Estimates";
import { useTodoSurfaces } from "@/hooks/useTodoPanel";
import { usePinboardSurfaces } from "@/hooks/usePinboardPanel";
import { NotificationsSection } from "@/components/settings/sections/Notifications";
import { PermissionsSection } from "@/components/settings/sections/Permissions";
import { ScheduleSection } from "@/components/settings/sections/Schedule";
import { ServersSection } from "@/components/settings/sections/Servers";
import { DevicesSection } from "@/components/settings/sections/Devices";
import { LinksSection } from "@/components/settings/sections/Links";
import { OutlookSection } from "@/components/settings/sections/Outlook";
import { NetworkSection } from "@/components/settings/sections/Network";
import { BackupSection } from "@/components/settings/sections/Backup";
import { scheduleLabel } from "@/lib/backupLabels";
import { trpc } from "@/lib/trpc";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { TimersSection } from "@/components/settings/sections/Timers";
import { StoreSection } from "@/components/settings/sections/Store";
import { UsersSection } from "@/components/settings/sections/Users";
import { ConnectionsSection } from "@/components/settings/sections/Connections";
import { BucketsSection } from "@/components/settings/sections/Buckets";
import { ClientsSection } from "@/components/settings/sections/Clients";
import { useBuckets } from "@/hooks/useBuckets";
import { useConnections } from "@/hooks/useConnections";
import type { Permission } from "@contracts/accounts";

export type SettingsCategory = {
  id: string;
  /** label, description and keywords are getters: translated when read, never at module level. */
  readonly label: string;
  readonly description: string;
  icon: LucideIcon;
  /** Words the search finds it by (its groups add their own), in every language. */
  readonly keywords: string;
  /** Only inside the native app. */
  nativeOnly?: boolean;
  /** Only inside the desktop app (not on phones). */
  desktopOnly?: boolean;
  /** Only for an account that may manage this (the server checks it too). */
  permission?: Permission;
  Content: () => ReactNode;
  /** One line of current state, under the name in the menu. */
  Summary: () => ReactNode;
};

/** The categories of Settings, in menu order. */
export const CATEGORIES: SettingsCategory[] = [
  {
    id: "account",
    get label() { return t("settings.categories.account.label"); },
    get description() { return t("settings.categories.account.description"); },
    icon: UserRound,
    get keywords() { return t("settings.categories.account.keywords"); },
    Content: AccountSection,
    Summary: () => useAuth().user?.displayName ?? null,
  },
  {
    id: "connections",
    get label() { return t("settings.categories.connections.label"); },
    get description() { return t("settings.categories.connections.description"); },
    icon: Plug,
    get keywords() { return t("settings.categories.connections.keywords"); },
    Content: ConnectionsSection,
    Summary: function ConnectionsSummary() {
      const n = useConnections().data?.length;
      return n === undefined ? null : t("settings.categories.connections.count", { count: n });
    },
  },
  {
    id: "buckets",
    get label() { return t("settings.categories.buckets.label"); },
    get description() { return t("settings.categories.buckets.description"); },
    icon: Layers,
    get keywords() { return t("settings.categories.buckets.keywords"); },
    Content: BucketsSection,
    Summary: function BucketsSummary() {
      return useBuckets().active?.name ?? null;
    },
  },
  {
    id: "clients",
    get label() { return t("settings.categories.clients.label"); },
    get description() { return t("settings.categories.clients.description"); },
    icon: Briefcase,
    get keywords() { return t("settings.categories.clients.keywords"); },
    Content: ClientsSection,
    Summary: function ClientsSummary() {
      const n = trpc.clients.list.useQuery().data?.clients.length;
      return n ? t("settings.categories.clients.count", { count: n }) : null;
    },
  },
  {
    id: "users",
    get label() { return t("settings.categories.users.label"); },
    get description() { return t("settings.categories.users.description"); },
    icon: Users,
    get keywords() { return t("settings.categories.users.keywords"); },
    permission: "manageUsers",
    Content: UsersSection,
    Summary: function UsersSummary() {
      const n = trpc.users.list.useQuery(undefined, { staleTime: 60_000 }).data?.length;
      return n === undefined ? null : t("settings.categories.users.count", { count: n });
    },
  },
  {
    id: "schedule",
    get label() { return t("settings.categories.schedule.label"); },
    get description() { return t("settings.categories.schedule.description"); },
    icon: CalendarClock,
    get keywords() { return t("settings.categories.schedule.keywords"); },
    Content: ScheduleSection,
    Summary: function ScheduleSummary() {
      const today = useToday();
      const { versions } = useWorkSchedule();
      return t("settings.categories.schedule.summary", {
        duration: formatDuration(weekSeconds(scheduleFor(today, versions), startOfWeek(today))),
      });
    },
  },
  {
    id: "timers",
    get label() { return t("settings.categories.timer.label"); },
    get description() { return t("settings.categories.timer.description"); },
    icon: Timer,
    get keywords() { return t("settings.categories.timer.keywords"); },
    Content: TimersSection,
    Summary: function TimersSummary() {
      const { data } = useSettingsForm();
      if (!data) return null;
      const alert =
        data.notifyEnabled && data.timerAlertMinutes
          ? t("settings.units.minutes", { count: data.timerAlertMinutes })
          : t("settings.categories.timer.alertOff");
      const idle = data.idleMinutes
        ? t("settings.units.minutes", { count: data.idleMinutes })
        : t("settings.categories.timer.idleOff");
      return t("settings.categories.timer.summary", { alert, idle });
    },
  },
  {
    id: "notifications",
    get label() { return t("settings.categories.notifications.label"); },
    get description() { return t("settings.categories.notifications.description"); },
    icon: Bell,
    get keywords() { return t("settings.categories.notifications.keywords"); },
    Content: NotificationsSection,
    Summary: () => (isNative() ? t("settings.categories.notifications.system") : (PERMISSION_LABEL[currentPermission()] ?? null)),
  },
  {
    id: "appearance",
    get label() { return t("settings.categories.appearance.label"); },
    get description() { return t("settings.categories.appearance.description"); },
    icon: Palette,
    get keywords() { return t("settings.categories.appearance.keywords"); },
    Content: AppearanceSection,
    Summary: function AppearanceSummary() {
      const { theme } = useTheme();
      const [density] = useDensity();
      const themeLabel = THEMES.find(x => x.value === (theme ?? "system"))?.label;
      const densityLabel = DENSITIES.find(x => x.value === density)?.label;
      return [themeLabel, densityLabel].filter(Boolean).join(" · ");
    },
  },
  {
    id: "pinboard",
    get label() { return t("settings.categories.pinboard.label"); },
    get description() { return t("settings.categories.pinboard.description"); },
    icon: Pin,
    get keywords() { return t("settings.categories.pinboard.keywords"); },
    Content: PinboardSection,
    Summary: function PinboardSummary() {
      const s = usePinboardSurfaces();
      const on = [s.board && t("settings.pinboard.onBoard"), s.menu && t("settings.pinboard.inMenu"), s.widget && t("settings.pinboard.widget")].filter(Boolean);
      return on.length ? on.join(" · ") : t("settings.pinboard.off");
    },
  },
  {
    id: "todos",
    get label() { return t("settings.categories.todos.label"); },
    get description() { return t("settings.categories.todos.description"); },
    icon: ListChecks,
    get keywords() { return t("settings.categories.todos.keywords"); },
    Content: TodosSection,
    Summary: function TodosSummary() {
      const s = useTodoSurfaces();
      const on = [s.menu && t("settings.todos.inMenu"), s.widget && t("settings.todos.widget"), s.corner && t("settings.todos.corner")].filter(Boolean);
      return on.length ? on.join(" · ") : t("settings.todos.off");
    },
  },
  {
    id: "estimates",
    get label() { return t("settings.categories.estimates.label"); },
    get description() { return t("settings.categories.estimates.description"); },
    icon: Hourglass,
    get keywords() { return t("settings.categories.estimates.keywords"); },
    Content: EstimatesSection,
    Summary: function EstimatesSummary() {
      const s = trpc.estimates.historyStates.useQuery(undefined, { staleTime: 60_000 }).data;
      return s ? t("settings.estimates.state.available", { count: s.available }) : null;
    },
  },
  {
    id: "outlook",
    get label() { return t("settings.categories.outlook.label"); },
    get description() { return t("settings.categories.outlook.description"); },
    icon: Mail,
    get keywords() { return t("settings.categories.outlook.keywords"); },
    Content: OutlookSection,
    Summary: function OutlookSummary() {
      const a = trpc.mails.account.useQuery(undefined, { staleTime: 60_000 }).data;
      if (!a) return null;
      return a.account ? t("settings.categories.outlook.signedIn", { account: a.account.account }) : t("settings.categories.outlook.off");
    },
  },
  {
    id: "links",
    get label() { return t("settings.categories.links.label"); },
    get description() { return t("settings.categories.links.description"); },
    icon: Link2,
    get keywords() { return t("settings.categories.links.keywords"); },
    Content: LinksSection,
    Summary: function LinksSummary() {
  const provider = useProviderName();
      const n = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.allowedLinkDomains.length;
      return n === undefined
        ? null
        : n === 0
          ? t("settings.categories.links.onlyJira", { provider })
          : t("settings.categories.links.domains", { count: n });
    },
  },
  {
    id: "backup",
    get label() { return t("settings.categories.backup.label"); },
    get description() { return t("settings.categories.backup.description"); },
    icon: DatabaseBackup,
    permission: "manageBackups",
    get keywords() { return t("settings.categories.backup.keywords"); },
    Content: BackupSection,
    Summary: function BackupSummary() {
      const s = trpc.backup.get.useQuery(undefined, { staleTime: 60_000 }).data?.settings;
      return s ? scheduleLabel(s) : null;
    },
  },
  {
    id: "servers",
    get label() { return t("settings.categories.server.label"); },
    get description() { return t("settings.categories.server.description"); },
    icon: Server,
    get keywords() { return t("settings.categories.server.keywords"); },
    nativeOnly: true,
    Content: ServersSection,
    Summary: function ServersSummary() {
      const n = useNativeProfiles().profiles?.list.length;
      return n === undefined ? null : t("settings.categories.server.count", { count: n });
    },
  },
  {
    id: "network",
    get label() { return t("settings.categories.network.label"); },
    get description() { return t("settings.categories.network.description"); },
    icon: Network,
    get keywords() { return t("settings.categories.network.keywords"); },
    permission: "manageServer",
    Content: NetworkSection,
    Summary: function NetworkSummary() {
      const n = trpc.egress.list.useQuery(undefined, { staleTime: 60_000 }).data?.length;
      return n === undefined ? null : t("settings.categories.network.hosts", { count: n });
    },
  },
  {
    id: "devices",
    get label() { return t("settings.categories.devices.label"); },
    get description() { return t("settings.categories.devices.description"); },
    icon: Smartphone,
    get keywords() { return t("settings.categories.devices.keywords"); },
    nativeOnly: true,
    desktopOnly: true,
    permission: "manageServer",
    Content: DevicesSection,
    Summary: function DevicesSummary() {
      const android = trpc.info.get.useQuery().data?.downloads.android;
      return android === undefined ? null : android ? `Android ${android.version}` : t("settings.categories.devices.addPhone");
    },
  },
  {
    id: "store",
    get label() { return t("settings.categories.store.label"); },
    get description() { return t("settings.categories.store.description"); },
    icon: Store,
    permission: "manageStore",
    get keywords() { return t("settings.categories.store.keywords"); },
    Content: StoreSection,
    Summary: function StoreSummary() {
      // No catalog fetch just for the summary: only what this server already knows.
      const waiting = trpc.store.pending.useQuery(undefined, { staleTime: 60_000 }).data?.pending.some(p => p.status === "pending");
      const active = trpc.modules.list.useQuery().data?.modules.filter(m => m.status.state === "active").length ?? 0;
      if (waiting) return t("settings.categories.store.pending");
      return active ? t("settings.categories.store.active", { count: active }) : null;
    },
  },
  {
    id: "permissions",
    get label() { return t("settings.categories.permissions.label"); },
    get description() { return t("settings.categories.permissions.description"); },
    icon: ShieldCheck,
    get keywords() { return t("settings.categories.permissions.keywords"); },
    nativeOnly: true,
    Content: PermissionsSection,
    Summary: function PermissionsSummary() {
      const [info] = useNativeInfo();
      if (!info) return null;
      const busy = info.shortcuts.filter(s => !s.ok).length;
      return busy
        ? t("settings.categories.permissions.shortcuts", { state: busyLabel(busy) })
        : t("settings.categories.permissions.allGood");
    },
  },
];

/**
 * The categories this window shows: native ones only in the app, desktop
 * ones not on phones, server-wide ones only to who may manage them.
 */
export function visibleCategories(permissions: readonly Permission[]): SettingsCategory[] {
  const native = isNative();
  const desktop = detectPlatform(navigator.userAgent, navigator.maxTouchPoints) === "desktop";
  return CATEGORIES.filter(
    c => (!c.nativeOnly || native) && (!c.desktopOnly || desktop) && (!c.permission || permissions.includes(c.permission)),
  );
}
