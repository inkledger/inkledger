import { toastError } from "@/lib/errorText";
import { useRef, type ReactNode } from "react";
import { Download, Info, KeyRound, RefreshCw, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import type { StoreEntry } from "@contracts/store";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { Chip } from "@/components/app/Chip";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { missingRequirements } from "@/lib/browserSupport";
import { Spinner } from "@/components/ui/spinner";
import { formatPrice, nameOf, type Locale } from "./format";
import { ManageBadge } from "./ManageBadge";
import { ModuleSwitch } from "./ModuleSwitch";
import { useModuleOffers } from "@/modules/context";
import { tellEnabled } from "@/modules/enabledSignals";
import { useStoreAccess } from "./access";

/** A call to action never wider than its card: its label truncates (the whole of it in its title). */
const FIT = "min-w-0 max-w-full";

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
  /** The install button pressed (its card is where a fresh module may come out of). */
  const pressed = useRef<HTMLElement | null>(null);
  const install = trpc.store.install.useMutation({
    onSuccess: r => {
      if (!e.installedVersion) tellEnabled(e.id, pressed.current);
      toast.success(
        e.installedVersion
          ? t("settings.store.updated", { name: nameOf(e, locale), version: r.version })
          : t("settings.store.installed", { name: nameOf(e, locale) })
      );
      refresh();
    },
    onError: err => toastError(err),
  });
  const dismiss = trpc.store.dismiss.useMutation({ onSuccess: refresh, onError: err => toastError(err) });

  const hasSettings = useModuleOffers(e.id, "settings");
  const access = useStoreAccess();
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
  // The status (if any) above, the action row last: in every card the switch, the badge and the button sit on the
  // card's bottom line, one baseline per row of cards. Toggling swaps content inside them, nothing mounts or moves.
  const both = (cta: ReactNode, status?: ReactNode) => (
    <span data-store-action className="ml-auto flex min-w-0 max-w-full flex-col items-end gap-1.5">
      {status && <span className="flex min-w-0 max-w-full justify-end">{status}</span>}
      <span data-store-action-row className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <ModuleSwitch moduleId={e.id} name={nameOf(e, locale)} installed={e.installed} />
        {manage}
        {cta}
      </span>
    </span>
  );

  if (e.pending?.status === "pending") {
    const kind = e.pending.kind;
    return both(
      <Button variant="outline" size={size} className={FIT} title={t(kind === "paid" ? "settings.store.waiting.paid" : "settings.store.waiting.request")} onClick={() => onOpen(kind === "paid" ? "paid" : "request")}>
        <Spinner />
        <span className="truncate">{t(kind === "paid" ? "settings.store.waiting.paid" : "settings.store.waiting.request")}</span>
      </Button>
    );
  }
  if (e.pending) {
    return both(
      <Button variant="ghost" size={size} onClick={() => dismiss.mutate({ product: e.product })}>
        {t("settings.store.dismiss")}
      </Button>,
      <Status tone="danger" text={e.pending.status === "declined" ? t("settings.store.declined") : t("settings.store.failed", { reason: e.pending.reason ?? "?" })} />
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
  // Installing or updating what the server holds a licence for is the Store manager's.
  if (e.licensed && (e.outdated || e.installed === null) && access.manage) {
    const update = e.outdated;
    return both(
      <Button size={size} className={FIT} disabled={install.isPending} onClick={ev => {
          pressed.current = ev.currentTarget;
          install.mutate({ product: e.product });
        }}>
        {install.isPending ? <Spinner /> : update ? <RefreshCw /> : <Download />}
        <span className="truncate">{update ? t("settings.store.update", { version: e.version }) : t("settings.store.install")}</span>
      </Button>
    );
  }
  // The installed build is the newest this inkledger runs; a newer one waits for an inkledger update.
  if (e.licensed && e.installed?.state === "active" && e.needsNewerHost) {
    return both(null, <Status dot tone="neutral" text={t("settings.store.newerNeedsHost")} />);
  }
  // Active, or licensed but refused: the badge says it and manages it. Someone who doesn't manage the Store
  // owns it only with a licence of their own (licensed is theirs): installed for others, it's still to get.
  if ((access.manage && e.installed?.state === "active") || e.licensed) return both(null);
  if (!e.supported) return both(null, <Status dot tone="warning" text={t("settings.store.unsupported")} />);
  return both(<ModeButton entry={e} locale={locale} size={size} priceOnButton={priceOnButton} onOpen={onOpen} />);
}

/** A card's status line: at most two lines (the whole text in its title), above the action row. */
function Status({ text, tone, dot = false }: { text: string; tone: "neutral" | "warning" | "danger"; dot?: boolean }) {
  return (
    <Chip tone={tone} variant={dot ? "dot" : "soft"} wrap title={text}>
      <span className="line-clamp-2 [overflow-wrap:anywhere]">{text}</span>
    </Chip>
  );
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
      <Button variant="outline" size={size} className={FIT} disabled>
        <span className="truncate">{t("settings.store.soon")}</span>
      </Button>
    );
  }
  if (e.mode === "request") {
    return (
      <Button size={size} className={FIT} title={t("settings.store.request")} onClick={() => onOpen("request")}>
        <KeyRound />
        <span className="truncate">{t("settings.store.request")}</span>
      </Button>
    );
  }
  return (
    <Button size={size} className={cn(FIT, "tabular")} onClick={() => onOpen("paid")}>
      <ShoppingBag />
      <span className="truncate">{priceOnButton ? formatPrice(e, locale) : t("settings.store.buy")}</span>
    </Button>
  );
}
