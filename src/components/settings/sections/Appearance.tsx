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
import { useSettingsSave } from "@/hooks/useSettingsForm";
import { useContext, useMemo } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModulesContext } from "@/modules/context";
import { currentLocale } from "@/i18n";
import { screensaver } from "@/lib/flag";
import { sceneList } from "@/components/screensaver/registry";
import { screensaverOverlay, screensaverScene } from "@/components/screensaver/settings";


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
      <ScreensaverGroup />
    </>
  );
}

/** Whether an add-on's light brings the night to the Dashboard after dark (e.g. Bonsai). */
function DashboardNightRow() {
  const on = (trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.dashboardNight ?? 1) === 1;
  const save = useSettingsSave();
  return (
    <SettingsRow label={t("settings.appearance.night")} hint={t("settings.appearance.nightHint")}>
      <Switch aria-label={t("settings.appearance.night")} checked={on} onCheckedChange={v => save.mutate({ dashboardNight: v })} />
    </SettingsRow>
  );
}

/** How much of an add-on's dashboard backdrop shows (e.g. City Window). */
function BackdropVisibilityRow() {
  const value = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.backdropVisibility ?? "normal";
  const save = useSettingsSave();
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

/** The screensaver's scene (the host's or an add-on's) and whether the clock shows over it. */
function ScreensaverGroup() {
  const ctx = useContext(ModulesContext);
  const scenes = useMemo(
    () => sceneList((ctx?.modules ?? []).map(m => ({ id: m.entry.id, name: m.entry.name, slots: Object.keys(m.module.mount) })), currentLocale(), t),
    [ctx?.modules]
  );
  const chosen = screensaverScene.use();
  const value = scenes.some(s => s.id === chosen) ? chosen : (scenes[0]?.id ?? "ink");
  const overlay = screensaverOverlay.use();
  return (
    <SettingsGroup id="appearance-screensaver" title={t("settings.appearance.screensaverTitle")} keywords={t("settings.appearance.screensaverKeywords")}>
      <SettingsRow label={t("settings.appearance.screensaverScene")} hint={t("settings.appearance.screensaverSceneHint")}>
        <SegmentedControl
          label={t("settings.appearance.screensaverScene")}
          value={value}
          onChange={v => screensaverScene.set(v)}
          options={scenes.map(s => ({ value: s.id, label: s.label }))}
        />
      </SettingsRow>
      <SettingsRow label={t("settings.appearance.screensaverOverlay")} hint={t("settings.appearance.screensaverOverlayHint")}>
        <Switch aria-label={t("settings.appearance.screensaverOverlay")} checked={overlay} onCheckedChange={v => screensaverOverlay.set(v)} />
      </SettingsRow>
      <SettingsRow label={t("settings.appearance.screensaverTry")}>
        <Button variant="outline" size="sm" onClick={() => screensaver.set(true)}>
          <Sparkles className="h-4 w-4" aria-hidden /> {t("settings.appearance.screensaverStart")}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
