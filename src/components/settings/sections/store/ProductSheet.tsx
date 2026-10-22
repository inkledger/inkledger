import { mediumDate } from "@/lib/dates";
import {
  Calendar,
  Settings2,
  Carrot,
  Heart,
  Moon,
  Shield,
  Shirt,
  Sparkles,
  Sprout,
  Sun,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { MODULE_TERMS_URL, type StoreEntry, type StoreIcon } from "@contracts/store";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { Chip } from "@/components/app/Chip";
import { SectionLabel } from "@/components/app/PageHeader";
import { ExternalLink } from "@/components/app/ExternalLink";
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Action, type StoreView } from "./Action";
import { Gallery, type Slide } from "./Gallery";
import { PanelHeader, PayPanel, RequestPanel } from "./panels";
import { Button } from "@/components/ui/button";
import { Link } from "react-router";
import { ModuleSlot } from "@/modules/ModuleHost";
import { useModuleOffers } from "@/modules/context";
import { loc, nameOf, type Locale } from "./format";
import { PriceTag } from "./PriceTag";
import { surface } from "@/components/app/surface";

const ICONS: Record<StoreIcon, LucideIcon> = {
  carrot: Carrot,
  sprout: Sprout,
  shirt: Shirt,
  trophy: Trophy,
  sun: Sun,
  shield: Shield,
  sparkles: Sparkles,
  heart: Heart,
  moon: Moon,
  calendar: Calendar,
};

/** The product sheet: details, then the request or payment step in place. */
export function ProductSheet({
  entry,
  view,
  locale,
  onView,
}: {
  entry: StoreEntry;
  view: StoreView;
  locale: Locale;
  onView: (view: StoreView) => void;
}) {
  if (view === "request") return <RequestPanel entry={entry} locale={locale} onBack={() => onView("details")} />;
  if (view === "paid") return <PayPanel entry={entry} locale={locale} onBack={() => onView("details")} />;
  if (view === "settings") return <SettingsPanel moduleId={entry.id} name={nameOf(entry, locale)} onBack={() => onView("details")} />;
  return <Details entry={entry} locale={locale} onView={onView} />;
}

export function BadgeChip({ badge }: { badge: NonNullable<StoreEntry["badge"]> }) {
  return <Chip tone={badge === "new" ? "info" : "success"}>{t(`settings.store.badge.${badge}`)}</Chip>;
}

/** The module's own settings, drawn by the module in the `settings` slot. */
export function SettingsPanel({ moduleId, name, onBack }: { moduleId: string; name: string; onBack?: () => void }) {
  const backdrop = useModuleOffers(moduleId, "dashboard-backdrop");
  return (
    <>
      <PanelHeader
        icon={Settings2}
        title={t("settings.store.moduleSettings.title", { name })}
        description={t("settings.store.moduleSettings.description", { name })}
        onBack={onBack}
      />
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <ModuleSlot id="settings" only={moduleId} />
        {backdrop && (
          <p className="mt-4 border-t pt-4 text-body-sm text-muted-foreground">
            {t("settings.store.moduleSettings.backdrop")}{" "}
            <Link to="/settings/appearance" className="underline underline-offset-2">
              {t("settings.appearance.backdrop")}
            </Link>
          </p>
        )}
      </div>
    </>
  );
}

function Details({ entry: e, locale, onView }: { entry: StoreEntry; locale: Locale; onView: (view: StoreView) => void }) {
  const name = nameOf(e, locale);
  const hasSettings = useModuleOffers(e.id, "settings") && e.installed?.state === "active";
  const slides: Slide[] = [
    ...(e.hero ? [{ src: e.hero, caption: "" }] : []),
    ...(e.gallery ?? []).map(g => ({ src: g.src, caption: loc(g.caption, locale) })),
  ];
  const paragraphs = e.description ? loc(e.description, locale) : [];

  return (
    <>
      <SheetHeader className="border-b p-5">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle className="font-display text-title">{name}</SheetTitle>
          {e.badge && <BadgeChip badge={e.badge} />}
        </div>
        <SheetDescription>{loc(e.tagline, locale)}</SheetDescription>
      </SheetHeader>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {slides.length > 0 && (
          <section className="border-b p-5">
            <Gallery slides={slides} />
          </section>
        )}

        {paragraphs.length > 0 && (
          <section className="grid gap-3 border-b p-5">
            {paragraphs.map((p, n) => (
              <p key={n} className="text-body">
                {p}
              </p>
            ))}
          </section>
        )}

        {e.highlights && e.highlights.length > 0 && (
          <section className="border-b p-5">
            <SectionLabel as="h3" className="mb-3 px-0">{t("settings.store.highlights")}</SectionLabel>
            <ul className="grid gap-4 sm:grid-cols-2">
              {e.highlights.map((h, n) => {
                const Icon = ICONS[h.icon];
                return (
                  <li key={n} className="flex gap-3">
                    <span {...surface("picture")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-strong">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{loc(h.title, locale)}</span>
                      <span className="block text-body-sm text-muted-foreground">{loc(h.body, locale)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="p-5">
          <SectionLabel as="h3" className="mb-3 px-0">{t("settings.store.info.title")}</SectionLabel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-body-sm">
            <dt className="text-muted-foreground">{t("settings.store.info.version")}</dt>
            <dd className="tabular">
              {e.version}
              {e.installedVersion && e.installedVersion !== e.version && (
                <span className="text-muted-foreground"> · {t("settings.store.info.installedVersion", { version: e.installedVersion })}</span>
              )}
            </dd>
            {e.requires?.includes("webgl2") && (
              <>
                <dt className="text-muted-foreground">{t("settings.store.info.requires")}</dt>
                <dd>{t("settings.store.info.requiresWebgl2")}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t("settings.store.info.price")}</dt>
            <dd className="tabular">
              <PriceTag entry={e} locale={locale} />
            </dd>
            <dt className="text-muted-foreground">{t("settings.store.info.privacy")}</dt>
            <dd>{t("settings.store.info.privacyBody")}</dd>
            <dt className="text-muted-foreground">{t("settings.store.info.licence")}</dt>
            <dd>
              <LicenceInfo product={e.product} />
            </dd>
            <dt className="text-muted-foreground">{t("settings.store.info.terms")}</dt>
            <dd>
              <ExternalLink url={MODULE_TERMS_URL}>{t("settings.store.info.termsLink")}</ExternalLink>
            </dd>
            {e.docsUrl && (
              <>
                <dt className="text-muted-foreground">{t("settings.store.info.docs")}</dt>
                <dd>
                  <ExternalLink url={e.docsUrl}>{t("settings.store.learnMore")}</ExternalLink>
                </dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <SheetFooter className="flex-row items-center gap-3 border-t p-5">
        <p className="mr-auto font-display text-heading tabular">
          <PriceTag entry={e} locale={locale} />
        </p>
        {hasSettings && (
          <Button variant="outline" onClick={() => onView("settings")}>
            <Settings2 />
            {t("settings.store.moduleSettings.open")}
          </Button>
        )}
        <Action entry={e} locale={locale} size="default" priceOnButton={false} onOpen={onView} />
      </SheetFooter>
    </>
  );
}

/** The licence this server holds for the product, or how licences work. */
function LicenceInfo({ product }: { product: string }) {
  const licence = trpc.modules.list.useQuery().data?.licenses.find(l => l.product === product);
  if (!licence) return <>{t("settings.store.info.licenceBody")}</>;
  const date = mediumDate(licence.issued);
  return (
    <>
      <span className="block">{t("settings.store.manage.licence", { id: licence.label, date })}</span>
      <span className="block text-muted-foreground">
        {t(`settings.store.issuer.${licence.issuer ?? "unknown"}`)} · {t("settings.store.manage.forever")}
      </span>
    </>
  );
}
