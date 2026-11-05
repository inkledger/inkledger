import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import type { Due } from "./due";

/** The "no due / today / tomorrow / pick a day" choice of a mail pinned as a TODO. */
export function DueSelect({ value, onChange, className }: { value: Due; onChange: (due: Due) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={v => onChange(v as Due)}>
      <SelectTrigger size="sm" className={className} aria-label={t("ui.mail.due")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t("ui.mail.noDue")}</SelectItem>
        <SelectItem value="today">{t("ui.mail.today")}</SelectItem>
        <SelectItem value="tomorrow">{t("ui.mail.tomorrow")}</SelectItem>
        <SelectItem value="pick">{t("ui.mail.pickDay")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
