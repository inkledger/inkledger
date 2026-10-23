import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router";
import { Moon, Pin, RefreshCw } from "lucide-react";
import { useTheme } from "next-themes";
import { useSync } from "@/hooks/useSync";
import { useSyncHint } from "@/hooks/useSyncHint";
import { togglePinboard, usePinboardSurfacesNow, usePinboardTarget } from "@/hooks/usePinboardPanel";
import { TAB_ROUTES, useNavItems } from "@/lib/nav";
import { SidebarFavorites } from "@/components/SidebarFavorites";
import { AccountMenu } from "@/components/AccountMenu";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ModuleSlot } from "@/modules/ModuleHost";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

const TILE =
  "flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-card px-1 text-caption font-medium text-muted-foreground transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * "More" from the tab bar: the sections not in the bar, the pinboard and the
 * favorites (▶ starts a timer right there), then sync, theme and account.
 */
export function MobileMoreSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { pathname } = useLocation();
  const { resolvedTheme, setTheme } = useTheme();
  const sync = useSync();
  const provider = useProviderName();
  const { hint, error } = useSyncHint();
  const sections = useNavItems()
    .flatMap(g => g.items)
    .filter(i => !TAB_ROUTES.includes(i.to));
  // The pinboard opened in place (the Board's sheet, the widget); with its page in the
  // menu, that section above is the way (never two "Pinboard" tiles), but on the Board.
  // Like the sidebar's pin: on the Board, the Board's own sheet.
  const pinTarget = usePinboardTarget(pathname, true);
  const { menu } = usePinboardSurfacesNow();
  const inPlace = pinTarget !== null && pinTarget !== "page" && !(menu && pinTarget === "float");

  // Any navigation (a section, a favorite, the account menu) closes it.
  const shown = useRef(pathname);
  useEffect(() => {
    if (pathname === shown.current) return;
    shown.current = pathname;
    onOpenChange(false);
  }, [pathname, onOpenChange]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] gap-0 rounded-t-2xl bg-canvas p-0">
        <div className="px-4 pb-3 pt-4">
          <SheetTitle className="font-display text-body font-semibold">{t("ui.layout.more")}</SheetTitle>
          <SheetDescription className="sr-only">{t("ui.layout.moreTitle")}</SheetDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-4">
          <nav aria-label={t("ui.layout.sections")} className="grid grid-cols-3 gap-2">
            {sections.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => onOpenChange(false)}
                {...surface("control")}
                className={cn(
                  TILE,
                  "aria-[current=page]:border-primary/40 aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-strong"
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                <span className="max-w-full truncate">{label}</span>
              </NavLink>
            ))}
            {inPlace && (
            <button
              type="button"
              aria-label={t("ui.layout.openPinboard")}
              onClick={() => {
                onOpenChange(false);
                // After the sheet lets go of focus, so the pinboard keeps it.
                requestAnimationFrame(() => togglePinboard(pathname, true));
              }}
              {...surface("control")}
              className={TILE}
            >
              <Pin className="h-5 w-5 -rotate-12" aria-hidden />
              <span className="max-w-full truncate">{t("pages.board.pinboard")}</span>
            </button>
            )}
          </nav>
          <ModuleSlot id="mobile-more" frame={boxes => <section className="grid gap-2">{boxes}</section>} />

          {/* Favorites as in the sidebar, rows and ▶ sized for a thumb. */}
          <div className="-mx-1 flex flex-col [&_.group>a]:py-2.5 [&_.group>a]:text-body-sm [&_.group>button]:h-9 [&_.group>button]:w-9 [&_.group>button_svg]:h-4 [&_.group>button_svg]:w-4">
            <SidebarFavorites onNavigate={() => onOpenChange(false)} />
          </div>

          <div className="grid divide-y rounded-xl border bg-card" {...surface("card")}>
            <button
              type="button"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="flex min-h-12 items-center gap-3 px-3 text-left text-body-sm font-medium disabled:opacity-70"
            >
              <RefreshCw
                className={cn("h-[18px] w-[18px] text-muted-foreground", sync.isPending && "motion-safe:animate-spin")}
                aria-hidden
              />
              <span className="flex min-w-0 flex-col leading-tight">
                {sync.isPending ? t("ui.layout.syncing") : t("ui.layout.syncJira", { provider })}
                {hint && !sync.isPending && (
                  <span
                    className={cn("truncate text-2xs font-normal", error ? "text-warning" : "text-muted-foreground")}
                    title={error ?? undefined}
                  >
                    {hint}
                  </span>
                )}
              </span>
            </button>
            <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 text-body-sm font-medium">
              <Moon className="h-[18px] w-[18px] text-muted-foreground" strokeWidth={1.75} aria-hidden />
              {t("ui.layout.darkTheme")}
              <Switch
                className="ml-auto"
                checked={resolvedTheme === "dark"}
                onCheckedChange={on => setTheme(on ? "dark" : "light")}
              />
            </label>
            <div className="grid p-1.5">
              <AccountMenu />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
