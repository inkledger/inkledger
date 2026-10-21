import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { WorkScheduleEditor } from "@/components/settings/WorkScheduleEditor";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";

export function ScheduleSection() {
  const { data, persist } = useSettingsForm();
  return (
    <>
      <SettingsGroup
        id="schedule-week"
        title={t("settings.schedule.weekTitle")}
        description={t("settings.schedule.weekDescription")}
        keywords={t("settings.schedule.weekKeywords")}
      >
        <WorkScheduleEditor />
      </SettingsGroup>
      <SettingsGroup
        id="schedule-goal"
        title={t("settings.schedule.goalTitle")}
        description={t("settings.schedule.goalDescription")}
        keywords={t("settings.schedule.goalKeywords")}
      >
        <SettingsRow label={t("settings.schedule.goalClock")} htmlFor="goal-clock" inline hint={t("settings.schedule.goalClockHint")}>
          <Switch
            id="goal-clock"
            checked={data?.goalBasis === "clock"}
            disabled={!data}
            onCheckedChange={on => persist({ goalBasis: on ? "clock" : "logged" })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
