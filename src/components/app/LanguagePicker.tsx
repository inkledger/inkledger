import { LOCALES, LOCALE_NAMES, setLocale, t, useLocale, type Locale } from "@/i18n";
import { SegmentedControl } from "@/components/app/SegmentedControl";

/** English / Italiano: each name in its own language, so it is found either way. */
export function LanguagePicker({ className }: { className?: string }) {
  const locale = useLocale();
  return (
    <SegmentedControl<Locale>
      label={t("common.language")}
      value={locale}
      onChange={setLocale}
      options={LOCALES.map(l => ({ value: l, label: LOCALE_NAMES[l] }))}
      className={className}
    />
  );
}
