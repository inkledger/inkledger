import { useState } from "react";
import type { SettingsData, SettingsPatch } from "@/hooks/useSettingsForm";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type NumericField = Exclude<keyof SettingsData, "notifyEnabled" | "overlapPolicy" | "shareLinkMinutes">;

/** Parses "7,5" / "7.5"; null when not a finite number. */
function parseDecimal(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
}

const wholeMinutes = (max: number) => ({
  format: (minutes: number) => String(minutes),
  parse: (text: string) => {
    const n = parseDecimal(text);
    return n !== null && Number.isInteger(n) && n >= 0 && n <= max ? n : null;
  },
});

const FIELDS: Record<
  NumericField,
  { format: (v: number) => string; parse: (text: string) => number | null }
> = {
  timerAlertMinutes: wholeMinutes(720),
  idleMinutes: wholeMinutes(240),
};

/**
 * One numeric setting. Keeps its own text while the user types and re-syncs
 * from the server only when not focused and not dirty, so refetches never
 * eat keystrokes. Saves just this field on blur / Enter when valid.
 */
export function SettingField({
  id,
  label,
  hint,
  field,
  server,
  inputMode,
  onSave,
  className,
}: {
  id: string;
  label: string;
  hint: string;
  field: NumericField;
  server: number;
  inputMode: "decimal" | "numeric";
  onSave: (patch: SettingsPatch) => void;
  className?: string;
}) {
  const { format, parse } = FIELDS[field];
  const serverText = format(server);
  const [text, setText] = useState(serverText);
  const [synced, setSynced] = useState(serverText);
  const [focused, setFocused] = useState(false);
  if (
    serverText !== synced &&
    (text === serverText || (!focused && text === synced))
  ) {
    setSynced(serverText);
    setText(serverText);
  }
  const value = parse(text);
  const ok = value !== null;

  const commit = () => {
    if (value === null) return; // stays red; other fields still save
    setText(format(value)); // "7.5" → "7,5", matches the server text
    if (value !== server) onSave({ [field]: value });
  };

  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={e => {
          if (e.key === "Enter") commit();
        }}
        inputMode={inputMode}
        value={text}
        onChange={e => setText(e.target.value)}
        aria-invalid={!ok}
        aria-describedby={`${id}-hint`}
      />
      <p
        id={`${id}-hint`}
        className={`text-caption ${ok ? "text-muted-foreground" : "text-danger"}`}
      >
        {hint}
        {!ok && !focused && ` · ${t("settings.field.unsaved")}`}
      </p>
    </div>
  );
}

