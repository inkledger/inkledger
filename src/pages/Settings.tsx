import { useAuth } from "@/hooks/useAuth";
import { useState } from "react";
import { Link, NavLink, Navigate, useNavigate, useParams } from "react-router";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelRow } from "@/components/app/Panel";
import { matches, SettingsSearch } from "@/lib/settingsSearch";
import { visibleCategories, type SettingsCategory } from "@/components/settings/sections";
import { useSettingsSaving } from "@/hooks/useSettingsForm";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

/**
 * Settings as a menu of categories and one category at a time (like the
 * system settings). Desktop: menu on the left, the category on the right
 * (the first one when none is chosen). Phone: the menu first; a category
 * opens full width with "← Settings". Every category has its URL
 * (/settings/permissions), so links can point straight at it.
 */
/** Section ids from before they were English: bookmarks and history still land. */
const LEGACY_SECTIONS: Record<string, string> = {
  orario: "schedule",
  timer: "timers",
  notifiche: "notifications",
  aspetto: "appearance",
  link: "links",
  server: "servers",
  dispositivi: "devices",
  permessi: "permissions",
  extras: "store",
};

export default function Settings() {
  const { section } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const categories = visibleCategories(user?.permissions ?? []);
  const [query, setQuery] = useState("");
  const saving = useSettingsSaving();

  const renamed = section ? LEGACY_SECTIONS[section] : undefined;
  if (renamed) return <Navigate to={`/settings/${renamed}`} replace />;

  const chosen = categories.find(c => c.id === section);
  // An unknown id (or a native-only one in the browser): back to the menu.
  if (section && !chosen) return <Navigate to="/settings" replace />;
  const active = chosen ?? categories[0];

  const shown = query.trim()
    ? categories.filter(c => matches(query, c.label, c.description, c.keywords))
    : categories;

  return (
    // The page holds still: the menu and the category scroll each on their own (desktop).
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <PageHeader
        title={t("pages.settings.title")}
        description={t("pages.settings.autosave")}
        // Saving: a small mark beside the title, never a different line (the page doesn't move).
        actions={
          <span role="status" aria-live="polite" className={cn("text-caption text-muted-foreground transition-opacity", !saving && "opacity-0")}>
            {t("pages.settings.saving")}
          </span>
        }
      />
      <PanelRow className="min-h-0 flex-1 lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-1">
        {/* Menu: always on desktop; on a phone only until a category is open. */}
        <nav
          aria-label={t("pages.settings.categories")}
          data-scroll-key="settings-menu"
          className={cn("min-w-0 border-b py-3 pl-[max(0.75rem,var(--surface-reach-l,0px))] pr-[max(0.75rem,var(--surface-reach-r,0px))] lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r", chosen && "max-lg:hidden")}
        >
          <div className="relative mb-3">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && shown[0]) void navigate(`/settings/${shown[0].id}`);
              }}
              placeholder={t("pages.settings.search")}
              aria-label={t("pages.settings.search")}
              className="pl-8"
            />
          </div>
          <ul className="grid min-w-0 grid-cols-1 gap-0.5">
            {shown.map(c => (
              <li key={c.id} className="min-w-0">
                <CategoryLink category={c} active={c.id === active.id} />
              </li>
            ))}
          </ul>
          {shown.length === 0 && (
            <p className="px-3 py-2 text-body-sm text-muted-foreground">{t("pages.settings.noResults")}</p>
          )}
        </nav>

        {/* The category: on a phone only once chosen. Another one starts at its top. */}
        <div key={active.id} data-scroll-key="settings-category" className={cn("min-w-0 lg:min-h-0 lg:overflow-y-auto", !chosen && "max-lg:hidden")}>
          <div className="border-b px-5 py-4 md:px-6">
            <Link
              to="/settings"
              className="mb-2 inline-flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground lg:hidden"
            >
              <ChevronLeft className="h-4 w-4" />
              {t("pages.settings.title")}
            </Link>
            <h2 className="font-display text-heading">{active.label}</h2>
            <p className="text-body-sm text-muted-foreground">{active.description}</p>
          </div>
          <SettingsSearch.Provider value={query}>
            <active.Content />
          </SettingsSearch.Provider>
        </div>
      </PanelRow>
    </div>
  );
}

function CategoryLink({ category: c, active }: { category: SettingsCategory; active: boolean }) {
  const Icon = c.icon;
  return (
    <NavLink
      to={`/settings/${c.id}`}
      aria-current={active ? "page" : undefined}
      {...surface("nav", { current: true, edge: false })}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-md px-3 py-2 outline-none transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40",
        active && "lg:bg-primary-soft lg:text-primary-strong"
      )}
    >
      <span
        aria-hidden
        {...surface("picture")}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
          active && "lg:bg-card lg:text-primary-strong"
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{c.label}</span>
        <span className={cn("block truncate text-caption text-muted-foreground", active && "lg:text-primary-strong")}>
          <c.Summary />
        </span>
      </span>
      <ChevronRight aria-hidden className="h-4 w-4 text-muted-foreground lg:hidden" />
    </NavLink>
  );
}
