import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { numberFormat, t } from "@/i18n";
import {
  DEFAULT_BASE,
  derivePalette,
  primaryContrast,
  THEME_PRESETS,
} from "@/lib/theme/derive";
import { parseHex } from "@/lib/theme/color";
import { themePreview, useThemeColor } from "@/hooks/useThemeColor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/app/Chip";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Base colour picker: everything else (primary, neutrals tint, chart accents,
 * covers, shadows) is derived from it. A choice applies and saves at once
 * (like Linear/Vercel), with "Undo" in the confirmation toast.
 */
export function ThemeColorPicker() {
  const id = useId();
  const utils = trpc.useUtils();
  const { current } = useThemeColor();
  const [hexInput, setHexInput] = useState(current);
  const [hexFocused, setHexFocused] = useState(false);
  // Follow the colour on screen (presets, picker, undo, other tabs) unless
  // the user is typing in the field.
  const [shown, setShown] = useState(current);
  if (shown !== current && !hexFocused) {
    setShown(current);
    setHexInput(current);
  }
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    hex: string;
  } | null>(null);

  /** Saved colour right now (not the one captured by an older render). */
  const savedNow = () =>
    utils.settings.get.getData()?.themeColor ?? DEFAULT_BASE;

  const update = trpc.settings.update.useMutation({
    // Optimistic: the whole app switches colour before the server answers.
    onMutate: async ({ themeColor }) => {
      await utils.settings.get.cancel();
      const previous = utils.settings.get.getData();
      if (previous && themeColor)
        utils.settings.get.setData(undefined, { ...previous, themeColor });
      themePreview.set(null);
      return { previous };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) utils.settings.get.setData(undefined, ctx.previous);
      toast.error(t("settings.theme.saveFailed", { message: e.message }));
    },
    onSettled: () => utils.settings.get.invalidate(),
  });

  const persist = (hex: string, undoTo: string | null) => {
    update.mutate(
      { themeColor: hex },
      {
        onSuccess: () => {
          if (!undoTo) return;
          toast.success(t("settings.theme.updated"), {
            action: {
              label: t("settings.theme.undo"),
              onClick: () => choose(undoTo, { undo: true }),
            },
          });
        },
      }
    );
  };

  /**
   * Apply a colour; presets save at once, dragging the picker saves after a
   * pause. Undo always saves its target: by then the cache already holds the
   * colour being undone, so comparing against it would skip the save.
   */
  const choose = (
    raw: string,
    opts: { debounce?: boolean; undo?: boolean } = {}
  ) => {
    const hex = raw.toUpperCase();
    setHexInput(hex);
    if (pending.current) clearTimeout(pending.current.timer);
    if (opts.debounce) {
      themePreview.set(hex);
      pending.current = {
        hex,
        timer: setTimeout(() => {
          pending.current = null;
          const previous = savedNow();
          // Dragged back to the saved colour: just drop the preview.
          if (hex === previous) themePreview.set(null);
          else persist(hex, previous);
        }, 400),
      };
      return;
    }
    pending.current = null;
    if (opts.undo) {
      persist(hex, null);
      return;
    }
    const previous = savedNow();
    if (hex === previous) themePreview.set(null);
    else persist(hex, previous);
  };

  const persistOnLeave = (hex: string) => update.mutate({ themeColor: hex });

  // Leaving the page mid-drag still saves the last colour instead of dropping it.
  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current.timer);
        persistOnLeave(pending.current.hex);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on unmount only
    []
  );

  const ratio = useMemo(() => primaryContrast(current), [current]);
  // Swatches show the pastel fill each preset produces, not the raw base.
  const swatches = useMemo(
    () =>
      new Map(
        THEME_PRESETS.map(p => [
          p.hex,
          `hsl(${derivePalette(p.hex).light["--primary"]})`,
        ])
      ),
    []
  );
  const validInput = parseHex(hexInput) !== null;

  return (
    <div className="grid gap-5">
      <div
        role="radiogroup"
        aria-label={t("settings.theme.presets")}
        className="flex flex-wrap gap-2"
      >
        {THEME_PRESETS.map(p => {
          const active = p.hex === current;
          return (
            <button
              key={p.hex}
              type="button"
              role="radio"
              aria-checked={active}
              title={p.name}
              onClick={() => choose(p.hex)}
              className={cn(
                "group flex items-center gap-2 rounded-lg border bg-background py-1.5 pl-1.5 pr-3 text-caption transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                active && "border-primary-strong/40 bg-primary-soft"
              )}
            >
              <span
                aria-hidden
                className="flex h-6 w-6 items-center justify-center rounded-md ring-1 ring-cover-ink/10"
                style={{ background: swatches.get(p.hex) }}
              >
                {active && (
                  <Check
                    className="h-3.5 w-3.5 text-white mix-blend-difference" /* design-ok */
                  />
                )}
              </span>
              {p.name}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-pick`} className="text-caption font-medium">
            {t("settings.theme.custom")}
          </label>
          <input
            id={`${id}-pick`}
            type="color"
            value={current.toLowerCase()}
            onChange={e => choose(e.target.value, { debounce: true })}
            className="h-9 w-14 cursor-pointer rounded-lg border bg-background p-1"
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-hex`} className="text-caption font-medium">
            {t("settings.theme.hex")}
          </label>
          <Input
            id={`${id}-hex`}
            value={hexInput}
            onFocus={() => setHexFocused(true)}
            onBlur={() => {
              setHexFocused(false);
              setHexInput(current); // drop half-typed values
            }}
            onChange={e => {
              const v = e.target.value.trim();
              setHexInput(v);
              if (parseHex(v))
                choose(v.startsWith("#") ? v : `#${v}`, { debounce: true });
            }}
            aria-invalid={!validInput}
            className="w-32 font-medium tabular uppercase"
            maxLength={7}
          />
        </div>
        <Chip
          tone={ratio.light >= 4.5 && ratio.dark >= 4.5 ? "success" : "danger"}
          className="mb-1.5"
        >
          AA · {numberFormat({ maximumFractionDigits: 1 }).format(ratio.light)}:1
        </Chip>
      </div>

      {/* Live sample of the derived palette */}
      <div aria-hidden className="overflow-hidden rounded-xl border bg-card">
        <div className="grain cover-sunset h-14" />
        <div className="grid gap-3 p-4">
          <div className="flex items-center gap-2">
            <ProjectAvatar project="IKL" size="sm" icon={false} />
            <span className="text-body-sm font-semibold">{t("settings.theme.preview")}</span>
            <Chip variant="dot" tone="info">
              {t("settings.theme.sampleNormal")}
            </Chip>
            <span className="ml-auto rounded-md bg-action px-2.5 py-1 text-caption font-medium text-action-foreground">
              {t("settings.theme.sampleLog")}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-3/5 rounded-full bg-primary" />
          </div>
          <div className="flex h-8 gap-1.5">
            <span className="flex-[5] rounded-md bg-chart-focus" />
            <span className="stripes-pending flex-[2] rounded-md" />
            <span className="flex-[3] rounded-md bg-chart-other" />
            <span className="flex-[2] rounded-md bg-chart-break" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0, 2, 4].map(n => (
              <span
                key={n}
                className={cn("grain h-10 rounded-lg", `cover-${n}`)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => choose(DEFAULT_BASE)}
          disabled={current === DEFAULT_BASE}
        >
          <RotateCcw className="h-4 w-4" />
          {t("settings.theme.reset")}
        </Button>
        <span className="text-caption text-muted-foreground">
          {update.isPending
            ? t("common.saving")
            : t("settings.theme.autosave")}
        </span>
      </div>
    </div>
  );
}
