import type { ReactNode } from "react";
import { Download, Info, KeyRound, RefreshCw, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import type { StoreEntry } from "@contracts/store";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { missingRequirements } from "@/lib/browserSupport";
import { Spinner } from "@/components/ui/spinner";
import { formatPrice, nameOf, type Locale } from "./format";
import { ManageBadge } from "./ManageBadge";
import { ModuleSwitch } from "./ModuleSwitch";
import { useModuleOffers } from "@/modules/context";

export type StoreView = "details" | "request" | "paid" | "settings";

/**
 * The server-driven call to action: what the catalog's mode and this
 * server's state allow (request, buy, install, update, or done).
 */
export function Action({
  entry: e,
  locale,
  size = "sm",
  priceOnButton = true,
  onOpen,
}: {
  entry: StoreEntry;
  locale: Locale;
  size?: "sm" | "default";
  /** Off where the price is already shown next to the button: it then reads "Buy". */
  priceOnButton?: boolean;
  onOpen: (view: StoreView) => void;
}) {
  const utils = trpc.useUtils();
  const refresh = () => {
    void utils.store.catalog.invalidate();
    void utils.modules.list.invalidate();
  };
  const install = trpc.store.install.useMutation({
    onSuccess: r => {
      toast.success(
        e.installedVersion
          ? t("settings.store.updated", { name: nameOf(e, locale), version: r.version })
          : t("settings.store.installed", { name: nameOf(e, locale) })
      );
      refresh();
    },
    onError: err => toast.error(err.message),
  });
  const dismiss = trpc.store.dismiss.useMutation({ onSuccess: refresh });

  const hasSettings = useModuleOffers(e.id, "settings");
  const manage = (
    <ManageBadge
      product={e.product}
      moduleId={e.id}
      name={nameOf(e, locale)}
      installed={e.installed}
      licensed={e.licensed}
      onSettings={hasSettings ? () => onOpen("settings") : undefined}
    />
  );
  const both = (cta: ReactNode) => (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <ModuleSwitch moduleId={e.id} name={nameOf(e, locale)} installed={e.installed} />
      {manage}
      {cta}
    </span>
  );

  if (e.pending?.status === "pending") {
    const kind = e.pending.kind;
    return both(
      <Button variant="outline" size={size} onClick={() => onOpen(kind === "paid" ? "paid" : "request")}>
        <Spinner />
        {t(kind === "paid" ? "settings.store.waiting.paid" : "settings.store.waiting.request")}
      </Button>
    );
  }
  if (e.pending) {
    return both(
      <>
        <Chip tone="danger">
          {e.pending.status === "declined" ? t("settings.store.declined") : t("settings.store.failed", { reason: e.pending.reason ?? "?" })}
        </Chip>
        <Button variant="ghost" size={size} onClick={() => dismiss.mutate({ product: e.product })}>
          {t("settings.store.dismiss")}
        </Button>
      </>
    );
  }
  // Not installable in this browser: a disabled button, and an "i" that says why.
  const missing = missingRequirements(e.requires);
  if (missing.length > 0 && e.installed === null) {
    return both(
      <span className="flex items-center gap-1">
        <Button variant="outline" size={size} disabled>
          {t("settings.store.needs.webgl2")}
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("settings.store.needs.why")}>
              <Info />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 text-body-sm">{t("settings.store.needs.webgl2Why")}</PopoverContent>
        </Popover>
      </span>
    );
  }
  if (e.licensed && (e.outdated || e.installed === null)) {
    const update = e.outdated;
    return both(
      <Button size={size} disabled={install.isPending} onClick={() => install.mutate({ product: e.product })}>
        {install.isPending ? <Spinner /> : update ? <RefreshCw /> : <Download />}
        {update ? t("settings.store.update", { version: e.version }) : t("settings.store.install")}
      </Button>
    );
  }
  // The installed build is the newest this inkledger runs; a newer one waits for an inkledger update.
  if (e.licensed && e.installed?.state === "active" && e.needsNewerHost) {
    return both(<Chip variant="dot" tone="neutral">{t("settings.store.newerNeedsHost")}</Chip>);
  }
  // Active, or licensed but refused: the badge says it and manages it.
  if (e.installed?.state === "active" || e.licensed) return both(null);
  if (!e.supported) return both(<Chip variant="dot" tone="warning">{t("settings.store.unsupported")}</Chip>);
  return both(<ModeButton entry={e} locale={locale} size={size} priceOnButton={priceOnButton} onOpen={onOpen} />);
}

/** What the catalog's mode offers to someone without a licence: ask, buy, or wait. */
function ModeButton({
  entry: e,
  locale,
  size,
  priceOnButton,
  onOpen,
}: {
  entry: StoreEntry;
  locale: Locale;
  size: "sm" | "default";
  priceOnButton: boolean;
  onOpen: (view: StoreView) => void;
}) {
  if (e.mode === "soon") {
    return (
      <Button variant="outline" size={size} disabled>
        {t("settings.store.soon")}
      </Button>
    );
  }
  if (e.mode === "request") {
    return (
      <Button size={size} onClick={() => onOpen("request")}>
        <KeyRound />
        {t("settings.store.request")}
      </Button>
    );
  }
  return (
    <Button size={size} className="tabular" onClick={() => onOpen("paid")}>
      <ShoppingBag />
      {priceOnButton ? formatPrice(e, locale) : t("settings.store.buy")}
    </Button>
  );
}
