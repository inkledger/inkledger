import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A time of day ("HH:MM", 5-minute steps), named by `label`; an emptied field changes nothing. */
export function TimeInput({
  value,
  onChange,
  label,
  disabled,
  invalid,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  return (
    <Input
      type="time"
      step={300}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={e => e.target.value && onChange(e.target.value)}
      className={cn("h-8 w-[6.5rem] px-2 tabular", className)}
    />
  );
}
