import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Switch } from "@/components/ui/switch";
import { useTodoSurfaces } from "@/hooks/useTodoPanel";
import { t } from "@/i18n";
import { useSettingsSave } from "@/hooks/useSettingsForm";

/** Where the TODO list lives: its page in the menu, the floating widget ("d"), the hot corner; each on or off. */
export function TodosSection() {
  const s = useTodoSurfaces();
  const save = useSettingsSave();
  const rows = [
    { key: "todosInMenu", on: s.menu, label: t("settings.todos.inMenu"), hint: t("settings.todos.inMenuHint") },
    { key: "todosWidget", on: s.widget, label: t("settings.todos.widget"), hint: t("settings.todos.widgetHint") },
    { key: "todosHotCorner", on: s.corner, label: t("settings.todos.corner"), hint: t("settings.todos.cornerHint") },
  ] as const;
  return (
    <SettingsGroup id="todos-places" title={t("settings.todos.placesTitle")} keywords={t("settings.todos.placesKeywords")}>
      {rows.map(r => (
        <SettingsRow key={r.key} label={r.label} hint={r.hint}>
          <Switch aria-label={r.label} checked={r.on} onCheckedChange={v => save.mutate({ [r.key]: v })} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
