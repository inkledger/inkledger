import type { ReactNode } from "react";
import { MousePointerClick, PencilLine, Route, Sparkles, TriangleAlert } from "lucide-react";
import { ToggleChip } from "@/components/app/ToggleChip";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LAYERS, type Layer, type LayerState } from "@/lib/workspace/layers";
import { t, type MessageKey } from "@/i18n";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

const ICONS: Record<Layer, React.ComponentType<{ className?: string }>> = { edit: PencilLine, use: MousePointerClick, paths: Route, friction: TriangleAlert, news: Sparkles };

export type PeriodOption = { id: string; label: string; imported: boolean };

/**
 * The layers laid over the page, each a chip that turns it on or off (they combine), and the period
 * the data layers read: shown only while one of them is on. New shows only when something is new,
 * with how many. A layer that cannot be drawn is disabled and says why on hover; the line under the
 * toolbar says it to everyone.
 */
export function LayerToolbar({ on, states, news, periods, period, onToggle, onPeriod, extra }: {
  on: ReadonlySet<Layer>;
  states: Record<Layer, LayerState>;
  /** How many new blocks and areas there are. */
  news: number;
  periods: readonly PeriodOption[];
  period: string | null;
  onToggle: (layer: Layer) => void;
  onPeriod: (id: string) => void;
  /** Beside the period: the switch between preview and the page as it is, the help. */
  extra?: ReactNode;
}) {
  const dataOn = on.has("use") || on.has("paths") || on.has("friction");
  const own = periods.filter(item => !item.imported);
  const imported = periods.filter(item => item.imported);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div
        role="toolbar"
        aria-label={t(key("layersLabel"))}
        className="flex min-w-0 flex-wrap items-center gap-1.5"
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[aria-pressed]:not([disabled])")];
          const at = buttons.findIndex(button => button === document.activeElement);
          if (at < 0) return;
          event.preventDefault();
          buttons[(at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}
      >
        {LAYERS.filter(layer => layer !== "news" || news > 0).map(layer => {
          const Icon = ICONS[layer];
          const state = states[layer];
          return (
            <ToggleChip
              key={layer}
              size="sm"
              pressed={on.has(layer)}
              disabled={!state.available}
              title={state.reason && state.reason !== "nothingNew" ? t(key(`layerReasons.${state.reason}`)) : undefined}
              onClick={() => onToggle(layer)}
              className="coarse:h-touch disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon className="h-3.5 w-3.5" />
              {t(key(`layers.${layer}`))}
              {layer === "news" && <span className="rounded-sm bg-primary-strong px-1 text-2xs tabular-nums text-primary-foreground">{news}</span>}
            </ToggleChip>
          );
        })}
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        {dataOn && period && periods.length > 0 && (
          <Select value={period} onValueChange={onPeriod}>
            <SelectTrigger size="sm" aria-label={t(key("usePeriod"))} className="w-auto min-w-40 max-w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {own.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
              </SelectGroup>
              {imported.length > 0 && (
                <SelectGroup>
                  <SelectLabel>{t(key("importedEvidence"))}</SelectLabel>
                  {imported.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        )}
        {extra}
      </div>
    </div>
  );
}
