import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Switch } from "@/components/ui/switch";
import { usePinboardSurfaces } from "@/hooks/usePinboardPanel";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/** Where the pinboard lives: the Board's panel, its page in the menu, the floating widget ("p"). Each on or off. */
export function PinboardSection() {
  const utils = trpc.useUtils();
  const s = usePinboardSurfaces();
  const save = trpc.settings.update.useMutation({ onSuccess: data => utils.settings.get.setData(undefined, data) });
  const rows = [
    { key: "pinboardOnBoard", on: s.board, label: t("settings.pinboard.onBoard"), hint: t("settings.pinboard.onBoardHint") },
    { key: "pinboardInMenu", on: s.menu, label: t("settings.pinboard.inMenu"), hint: t("settings.pinboard.inMenuHint") },
    { key: "pinboardWidget", on: s.widget, label: t("settings.pinboard.widget"), hint: t("settings.pinboard.widgetHint") },
  ] as const;
  return (
    <SettingsGroup id="pinboard-places" title={t("settings.pinboard.placesTitle")} keywords={t("settings.pinboard.placesKeywords")}>
      {rows.map(r => (
        <SettingsRow key={r.key} label={r.label} hint={r.hint}>
          <Switch aria-label={r.label} checked={r.on} disabled={save.isPending} onCheckedChange={v => save.mutate({ [r.key]: v })} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
