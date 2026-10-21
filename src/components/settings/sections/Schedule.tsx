import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { WorkScheduleEditor } from "@/components/settings/WorkScheduleEditor";
import { t } from "@/i18n";

// Goals always count the hours worked: work done in parallel once (no setting).
export function ScheduleSection() {
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
    </>
  );
}
