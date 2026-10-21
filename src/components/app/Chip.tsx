import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/jira";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  info: "bg-info/70",
  success: "bg-success/70",
  warning: "bg-warning/70",
  danger: "bg-danger/70",
};

/**
 * Compact label. `dot` (status, priority): neutral chip with a coloured dot,
 * so lists stay tone-on-tone. `soft` (default): tinted fill, reserved for
 * alerts (overdue, queued, errors).
 */
export function Chip({
  tone = "neutral",
  variant = "soft",
  className,
  children,
}: {
  tone?: Tone;
  variant?: "soft" | "dot";
  className?: string;
  children: React.ReactNode;
}) {
  const dot = variant === "dot";
  return (
    <span
      data-lit="1"
      className={cn(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 text-caption font-medium",
        dot ? "bg-muted text-foreground/75" : TONES[tone],
        className
      )}
    >
      {dot && <Dot tone={tone} className="h-1.5 w-1.5" />}
      {children}
    </span>
  );
}

/** Small round status dot; always pair it with visible or sr-only text. */
export function Dot({
  tone = "neutral",
  className,
}: {
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        DOTS[tone],
        className
      )}
    />
  );
}
