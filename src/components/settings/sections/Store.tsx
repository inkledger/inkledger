import { useEffect, useRef, useState } from "react";
import { FileKey, Grid3x3, LayoutGrid, Store } from "lucide-react";
import { toast } from "sonner";
import type { ModuleListEntry } from "@contracts/modules";
import { LICENSE_FILE_EXTENSION, type StoreEntry } from "@contracts/store";
import { trpc } from "@/lib/trpc";
import { getLocale, t, useLocale } from "@/i18n";
import { modulesDisabled, setModulesDisabled } from "@/modules/loader";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Action, type StoreView } from "./store/Action";
import { BadgeChip, ProductSheet, SettingsPanel } from "./store/ProductSheet";
import { useModuleOffers } from "@/modules/context";
import { ModuleSwitch } from "./store/ModuleSwitch";
import { loc, nameOf, type Locale } from "./store/format";
import { PriceTag } from "./store/PriceTag";
import { ManageBadge } from "./store/ManageBadge";
import { StoreImage } from "./store/StoreImage";

const POLL_MS = 10_000;
const LAYOUT_KEY = "ikl-store-layout";

type Layout = "large" | "compact";

/** Large cards or a compact grid of small tiles: per device, like the density. */
function useLayout(): [Layout, (l: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === "compact" ? "compact" : "large";
    } catch {
      return "large";
    }
  });
  const set = (l: Layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* storage unavailable: still applies for this visit */
    }
    setLayout(l);
  };
  return [layout, set];
}

/**
 * Settings → Store: every module in one place. The catalog the store Worker
 * serves (cards, product sheets), modules installed here that it does not
 * list, and the switch that turns them all off.
 */
export function StoreSection() {
  const locale = useLocale();
  const utils = trpc.useUtils();
  const catalog = trpc.store.catalog.useQuery(undefined, { retry: false });
  const local = trpc.modules.list.useQuery();
  const [open, setOpen] = useState<{ product: string; view: StoreView } | null>(null);
  const [layout, setLayout] = useLayout();
  const entries = catalog.data?.entries ?? [];
  const waiting = entries.some(e => e.pending?.status === "pending");

  // While something waits for the Worker, the server polls it and installs what lands.
  const pending = trpc.store.pending.useQuery(undefined, { enabled: waiting, refetchInterval: POLL_MS });
  const installed = pending.data?.installed;
  useEffect(() => {
    if (!installed?.length) return;
    for (const product of installed) {
      const e = entries.find(x => x.product === product);
      toast.success(t("settings.store.installed", { name: e ? nameOf(e, locale) : product }));
    }
    void utils.store.catalog.invalidate();
    void utils.modules.list.invalidate();
    // Only on a new poll result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed]);
  useEffect(() => {
    if (pending.data && pending.data.installed.length === 0) void utils.store.catalog.invalidate();
  }, [pending.data, utils]);

  // The sheet follows the live entry; once the module is active, back to its details.
  const current = open ? entries.find(e => e.product === open.product) : undefined;
  const settled = current?.installed?.state === "active" && !current.outdated;
  const view: StoreView = settled && open?.view !== "settings" ? "details" : (open?.view ?? "details");
  const show = (product: string) => (v: StoreView) => setOpen({ product, view: v });

  if (catalog.isLoading || local.isLoading) return <Skeleton className="m-6 h-40" />;
  // Installed here but not (or no longer) in the catalog, e.g. with the store off.
  const others = (local.data?.modules ?? []).filter(m => !entries.some(e => e.product === m.product));

  return (
    <>
      {local.data?.extraKey && (
        <p role="alert" className="mb-4 rounded-md bg-warning-soft px-3 py-2 text-body-sm text-warning">
          {t("settings.store.extraKey")}
        </p>
      )}
      <SettingsGroup
        id="store-modules"
        title={t("settings.store.title")}
        description={t("settings.store.description")}
        keywords={t("settings.store.keywords")}
        actions={
          <>
            <SegmentedControl
              label={t("settings.store.layout.label")}
              value={layout}
              onChange={setLayout}
              options={[
                { value: "large", label: t("settings.store.layout.large"), icon: LayoutGrid },
                { value: "compact", label: t("settings.store.layout.compact"), icon: Grid3x3 },
              ]}
            />
            <RestoreLicence />
          </>
        }
      >
        {catalog.error ? (
          <ErrorState message={catalog.error.message} onRetry={() => void catalog.refetch()} />
        ) : !catalog.data?.enabled ? (
          <EmptyState icon={Store} title={t("settings.store.offTitle")} message={t("settings.store.off")} />
        ) : entries.length === 0 && others.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t("settings.store.empty")}</p>
        ) : null}
        {(entries.length > 0 || others.length > 0) && (
          <ul data-store-layout={layout} className={layout === "compact" ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" : "grid gap-4 sm:grid-cols-2"}>
            {entries.map(e =>
              layout === "compact" ? (
                <StoreTile key={e.product} entry={e} locale={locale} onOpen={show(e.product)} />
              ) : (
                <StoreCard key={e.product} entry={e} locale={locale} onOpen={show(e.product)} />
              )
            )}
            {others.map(m => (
              <LocalCard
                key={m.id}
                module={m}
                locale={locale}
                licensed={(local.data?.licenses ?? []).some(l => l.product === m.product)}
                className={layout === "compact" ? "col-span-2" : undefined}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>

      <OffSwitch />

      <Sheet open={current !== undefined} onOpenChange={o => !o && setOpen(null)}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
          {current && <ProductSheet entry={current} view={view} locale={locale} onView={show(current.product)} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

function StoreCard({ entry: e, locale, onOpen }: { entry: StoreEntry; locale: Locale; onOpen: (view: StoreView) => void }) {
  const name = nameOf(e, locale);
  return (
    <li data-store-item={e.id} className="flex flex-col overflow-hidden rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => onOpen("details")}
        aria-label={t("settings.store.openDetails", { name })}
        className="group relative block overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StoreImage src={e.hero ?? e.image} className="aspect-video w-full transition-transform duration-300 group-hover:scale-[1.02]" />
        {e.badge && (
          <span className="absolute left-3 top-3">
            <BadgeChip badge={e.badge} />
          </span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <p className="flex items-baseline gap-2">
          <span className="font-display text-heading">{name}</span>
          <span className="text-caption text-muted-foreground tabular">{t("settings.store.version", { version: e.version })}</span>
        </p>
        <p className="text-body-sm text-muted-foreground">{loc(e.tagline, locale)}</p>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
          {/* A paid module's button already shows the price; one already owned needs none. */}
          {e.mode === "paid" || e.licensed ? (
            <span className="mr-auto" />
          ) : (
            <PriceTag entry={e} locale={locale} className="mr-auto text-body-sm font-medium tabular" />
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpen("details")}>
            {t("settings.store.details")}
          </Button>
          <Action entry={e} locale={locale} onOpen={onOpen} />
        </div>
      </div>
    </li>
  );
}

/** The compact grid's tile: the picture, the name, and what can be done (the sheet has the rest). */
function StoreTile({ entry: e, locale, onOpen }: { entry: StoreEntry; locale: Locale; onOpen: (view: StoreView) => void }) {
  const name = nameOf(e, locale);
  return (
    <li data-store-item={e.id} className="flex flex-col overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => onOpen("details")}
        aria-label={t("settings.store.openDetails", { name })}
        className="group relative block overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StoreImage src={e.hero ?? e.image} className="aspect-[16/10] w-full transition-transform duration-300 group-hover:scale-[1.02]" />
        {e.badge && (
          <span className="absolute left-2 top-2">
            <BadgeChip badge={e.badge} />
          </span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <p className="truncate text-body-sm font-medium" title={name}>
          {name}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {e.mode === "paid" || e.licensed ? (
            <span className="mr-auto" />
          ) : (
            <PriceTag entry={e} locale={locale} className="mr-auto text-caption font-medium tabular" />
          )}
          <Action entry={e} locale={locale} onOpen={onOpen} />
        </div>
      </div>
    </li>
  );
}

/** A module installed here that the store does not list: only its status and management. */
function LocalCard({
  module: m,
  locale,
  licensed,
  className,
}: {
  module: ModuleListEntry;
  locale: Locale;
  licensed: boolean;
  className?: string;
}) {
  const name = loc(m.name, locale);
  const hasSettings = useModuleOffers(m.id, "settings");
  const [settings, setSettings] = useState(false);
  return (
    <li data-store-item={m.id} className={cn("flex items-center gap-3 rounded-xl border bg-card p-4", className)}>
      <StoreImage className="h-12 w-12 shrink-0 rounded-lg" />
      <p className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        <span className="text-caption text-muted-foreground tabular">{t("settings.store.version", { version: m.version })}</span>
      </p>
      <ModuleSwitch moduleId={m.id} name={name} installed={m.status} />
      <ManageBadge
        product={m.product}
        moduleId={m.id}
        name={name}
        installed={m.status}
        licensed={licensed}
        onSettings={hasSettings ? () => setSettings(true) : undefined}
      />
      <Sheet open={settings} onOpenChange={setSettings}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
          <SettingsPanel moduleId={m.id} name={name} />
        </SheetContent>
      </Sheet>
    </li>
  );
}

/** Turns every module off on this device (the way out if one misbehaves). */
function OffSwitch() {
  const [off, setOff] = useState(modulesDisabled);
  return (
    <SettingsGroup id="store-off" title={t("settings.store.offSwitch.title")} keywords={t("settings.store.keywords")}>
      <SettingsRow inline label={t("settings.store.offSwitch.label")} hint={t("settings.store.offSwitch.hint")}>
        <Switch
          aria-label={t("settings.store.offSwitch.label")}
          checked={off}
          onCheckedChange={v => {
            setModulesDisabled(v);
            setOff(v);
            window.location.reload();
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** A licence issued before (its file), e.g. to move a purchase to this server. */
function RestoreLicence() {
  const utils = trpc.useUtils();
  const input = useRef<HTMLInputElement>(null);
  const restore = trpc.store.restoreLicense.useMutation({
    onSuccess: r => {
      const entry = utils.store.catalog.getData()?.entries.find(e => e.product === r.product);
      toast.success(t("settings.store.restore.done", { product: entry ? loc(entry.name, getLocale()) : r.product }));
      void utils.store.catalog.invalidate();
      void utils.modules.list.invalidate();
    },
    onError: e => toast.error(e.message),
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={`${LICENSE_FILE_EXTENSION},.json,.txt`}
        className="sr-only"
        aria-label={t("settings.store.restore.label")}
        onChange={ev => {
          const file = ev.target.files?.[0];
          ev.target.value = "";
          if (file) void file.text().then(text => restore.mutate({ text }));
        }}
      />
      <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => input.current?.click()}>
        <FileKey />
        {t("settings.store.restore.label")}
      </Button>
    </>
  );
}
