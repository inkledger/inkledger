import { useState } from "react";
import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { parseDayKey } from "@contracts/time";
import { PRESET_OPTIONS, type PresetId } from "@/lib/reportLabel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { t, dateFormat } from "@/i18n";

const short = () => dateFormat({ day: "numeric", month: "short" });

/**
 * One header control for the report period: presets plus a custom range,
 * like the period pickers of Linear / Stripe (keeps the header on one row).
 */
export function PeriodPicker({
  from,
  to,
  preset,
  valid,
  onPreset,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  preset: PresetId | null;
  valid: boolean;
  onPreset: (id: PresetId) => void;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const a = parseDayKey(from);
  const b = parseDayKey(to);
  const range = a && b ? `${short().format(a)} – ${short().format(b)}` : "—";
  const presetLabel = PRESET_OPTIONS.find(p => p.value === preset)?.label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-invalid={!valid}>
          <CalendarDays className="h-4 w-4" />
          {presetLabel ? (
            <>
              {presetLabel}
              <span className="text-muted-foreground">· {range}</span>
            </>
          ) : (
            range
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <ul role="listbox" aria-label={t("views.reports.period.preset")} className="grid">
          {PRESET_OPTIONS.map(p => (
            <li key={p.value}>
              <button
                type="button"
                role="option"
                aria-selected={p.value === preset}
                onClick={() => {
                  onPreset(p.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-body-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  p.value === preset && "font-medium"
                )}
              >
                {p.label}
                {p.value === preset && <Check className="h-4 w-4" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-1.5 grid grid-cols-2 gap-2 border-t px-1 pb-1 pt-2.5">
          <div className="grid gap-1">
            <Label htmlFor="report-from" className="text-caption">
              {t("views.reports.period.from")}
            </Label>
            <Input
              id="report-from"
              type="date"
              value={from}
              onChange={e => onFrom(e.target.value)}
              aria-invalid={!valid}
              className="h-8 px-2 text-caption"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="report-to" className="text-caption">
              {t("views.reports.period.to")}
            </Label>
            <Input
              id="report-to"
              type="date"
              value={to}
              onChange={e => onTo(e.target.value)}
              aria-invalid={!valid}
              className="h-8 px-2 text-caption"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
