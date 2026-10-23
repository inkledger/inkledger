import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Switch } from "@/components/ui/switch";
import { useTodoSurfaces } from "@/hooks/useTodoPanel";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/** Where the TODO list lives: its page in the menu, the floating widget ("d"), the hot corner; each on or off. */
export function TodosSection() {
  const utils = trpc.useUtils();
  const s = useTodoSurfaces();
  const save = trpc.settings.update.useMutation({ onSuccess: data => utils.settings.get.setData(undefined, data) });
  const rows = [
    { key: "todosInMenu", on: s.menu, label: t("settings.todos.inMenu"), hint: t("settings.todos.inMenuHint") },
    { key: "todosWidget", on: s.widget, label: t("settings.todos.widget"), hint: t("settings.todos.widgetHint") },
    { key: "todosHotCorner", on: s.corner, label: t("settings.todos.corner"), hint: t("settings.todos.cornerHint") },
  ] as const;
  return (
    <SettingsGroup id="todos-places" title={t("settings.todos.placesTitle")} keywords={t("settings.todos.placesKeywords")}>
      {rows.map(r => (
        <SettingsRow key={r.key} label={r.label} hint={r.hint}>
          <Switch aria-label={r.label} checked={r.on} disabled={save.isPending} onCheckedChange={v => save.mutate({ [r.key]: v })} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
