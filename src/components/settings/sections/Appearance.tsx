import { useTheme } from "next-themes";
import { useDensity } from "@/hooks/useDensity";
import { DENSITIES, THEMES } from "@/lib/appearance";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { LanguagePicker } from "@/components/app/LanguagePicker";
import { ThemeColorPicker } from "@/components/settings/ThemeColorPicker";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { BACKDROP_VISIBILITY, type BackdropVisibility } from "@contracts/modules";
import { Switch } from "@/components/ui/switch";


export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const [density, setDensity] = useDensity();
  return (
    <>
      <SettingsGroup id="appearance-language" title="Lingua / Language" keywords="lingua language english italiano inglese">
        <SettingsRow label="Lingua / Language">
          <LanguagePicker />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup id="appearance-display" title={t("settings.appearance.displayTitle")} keywords={t("settings.appearance.displayKeywords")}>
        <SettingsRow label={t("settings.appearance.theme")}>
          <SegmentedControl label={t("settings.appearance.theme")} value={theme ?? "system"} onChange={setTheme} options={THEMES} />
        </SettingsRow>
        <SettingsRow label={t("settings.appearance.density")} hint={t("settings.appearance.densityHint")}>
          <SegmentedControl label={t("settings.appearance.density")} value={density} onChange={setDensity} options={DENSITIES} />
        </SettingsRow>
        <BackdropVisibilityRow />
        <DashboardNightRow />
      </SettingsGroup>
      <SettingsGroup
        id="appearance-color"
        title={t("settings.appearance.colorTitle")}
        description={t("settings.appearance.colorDescription")}
        keywords={t("settings.appearance.colorKeywords")}
      >
        <ThemeColorPicker />
      </SettingsGroup>
    </>
  );
}

/** Whether an add-on's light brings the night to the Dashboard after dark (e.g. Bonsai). */
function DashboardNightRow() {
  const utils = trpc.useUtils();
  const on = (trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.dashboardNight ?? 1) === 1;
  const save = trpc.settings.update.useMutation({ onSuccess: data => utils.settings.get.setData(undefined, data) });
  return (
    <SettingsRow label={t("settings.appearance.night")} hint={t("settings.appearance.nightHint")}>
      <Switch aria-label={t("settings.appearance.night")} checked={on} disabled={save.isPending} onCheckedChange={v => save.mutate({ dashboardNight: v })} />
    </SettingsRow>
  );
}

/** How much of an add-on's dashboard backdrop shows (e.g. City Window). */
function BackdropVisibilityRow() {
  const utils = trpc.useUtils();
  const value = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.backdropVisibility ?? "normal";
  const save = trpc.settings.update.useMutation({ onSuccess: data => utils.settings.get.setData(undefined, data) });
  return (
    <SettingsRow label={t("settings.appearance.backdrop")} hint={t("settings.appearance.backdropHint")}>
      <SegmentedControl
        label={t("settings.appearance.backdrop")}
        value={value}
        onChange={v => save.mutate({ backdropVisibility: v as BackdropVisibility })}
        options={BACKDROP_VISIBILITY.map(v => ({ value: v, label: t(`settings.appearance.backdropLevel.${v}`) }))}
      />
    </SettingsRow>
  );
}
