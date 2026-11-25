import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { nextIndex } from "@/lib/roving";
import { surface } from "@/components/app/surface";
import { SettingsRow } from "@/components/settings/SettingsGroup";
import { useSettingsSave } from "@/hooks/useSettingsForm";
import { useAppearancePrefs, useThemeColor } from "@/hooks/useThemeColor";
import { resolveContrast } from "@/lib/theme/apply";
import { derivePalette, type ThemeLook, type ThemeVars } from "@/lib/theme/derive";
import { THEME_CONTRASTS, THEME_VARIANTS } from "@contracts/theme";
import { t } from "@/i18n";

const key = (look: ThemeLook) => `${look.variant}-${look.contrast}`;
const vars = (v: ThemeVars) => Object.entries(v).map(([k, x]) => `${k}:${x}`).join(";");

/**
 * Each preview tile carries the palette it previews on a wrapper attribute, in the scheme on
 * screen: inside it the usual token classes draw that look (no colour in a style attribute).
 */
function PreviewStyles({ base, looks }: { base: string; looks: ThemeLook[] }) {
  const css = useMemo(
    () =>
      looks
        .map(look => {
          const p = derivePalette(base, look);
          const sel = `[data-look-preview="${key(look)}"]`;
          return `html ${sel}{${vars(p.light)}}html.dark ${sel}{${vars(p.dark)}}`;
        })
        .join(""),
    [base, looks]
  );
  return <style>{css}</style>;
}

/** A small page in the look: canvas, a card with text, muted text, an accent and the main action. */
function Preview({ look }: { look: ThemeLook }) {
  return (
    <span aria-hidden data-look-preview={key(look)} className="block w-28 rounded-md bg-canvas p-1.5">
      {/* surface: none — a drawing of a card inside the option, not a card of the page */}
      <span className="grid gap-1 rounded-sm border bg-card p-1.5 text-left">
        <span className="font-display text-body-sm font-semibold leading-none text-foreground">{t("settings.appearance.previewSample")}</span>
        <span className="block h-1 w-14 rounded-sm bg-muted-foreground" />
        <span className="flex items-center gap-1">
          <span className="block h-2 flex-1 rounded-sm bg-primary" />
          <span className="block h-2 w-5 rounded-sm bg-action" />
        </span>
      </span>
    </span>
  );
}

/** One radio group of preview tiles (arrow keys move and choose, one Tab stop). */
function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; look: ThemeLook }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-2"
      onKeyDown={e => {
        const n = nextIndex(options.findIndex(o => o.value === value), options.length, e);
        if (n === null) return;
        e.preventDefault();
        onChange(options[n].value);
        e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[n]?.focus();
      }}
    >
      {options.map(o => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            {...surface("control", { on: active })}
            onClick={() => onChange(o.value)}
            className={cn(
              "grid gap-1.5 rounded-lg border bg-background p-1.5 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "border-primary-strong bg-primary-soft text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Preview look={o.look} />
            <span className="px-0.5 text-left">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Settings → Appearance: the variant (standard, soft) and the contrast (normal, high, system), each with a live preview. */
export function LookPicker() {
  const { current } = useThemeColor();
  const prefs = useAppearancePrefs();
  const save = useSettingsSave();
  const contrastNow = resolveContrast(prefs.contrast);
  const variantOptions = THEME_VARIANTS.map(v => ({
    value: v,
    label: t(`settings.appearance.variantOption.${v}`),
    look: { variant: v, contrast: contrastNow },
  }));
  const contrastOptions = THEME_CONTRASTS.map(c => ({
    value: c,
    label: t(`settings.appearance.contrastOption.${c}`),
    look: { variant: prefs.variant, contrast: c === "system" ? resolveContrast("system") : c },
  }));
  const looks = useMemo(() => {
    const all = [...variantOptions, ...contrastOptions].map(o => o.look);
    return all.filter((l, i) => all.findIndex(x => key(x) === key(l)) === i);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the options follow these two values
  }, [prefs.variant, contrastNow]);
  return (
    <>
      <PreviewStyles base={current} looks={looks} />
      <SettingsRow label={t("settings.appearance.variant")} hint={t("settings.appearance.variantHint")}>
        <Choices label={t("settings.appearance.variant")} value={prefs.variant} options={variantOptions} onChange={v => save.mutate({ themeVariant: v })} />
      </SettingsRow>
      <SettingsRow label={t("settings.appearance.contrast")} hint={t("settings.appearance.contrastHint")}>
        <Choices label={t("settings.appearance.contrast")} value={prefs.contrast} options={contrastOptions} onChange={c => save.mutate({ themeContrast: c })} />
      </SettingsRow>
    </>
  );
}
