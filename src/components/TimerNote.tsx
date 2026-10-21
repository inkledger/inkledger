import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/**
 * "What are you working on?" for a timer: saved while typing (debounced) and
 * pre-filled as the worklog comment when the time is logged.
 */
export function TimerNote({
  issueKey,
  connectionId,
  note,
  className,
  inputClassName,
}: {
  issueKey: string;
  connectionId?: number;
  note: string;
  className?: string;
  inputClassName?: string;
}) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(note);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Text typed but not yet confirmed by the server. */
  const unsaved = useRef<string | null>(null);
  const save = trpc.timers.setNote.useMutation({
    onSuccess: (_r, vars) => {
      if (unsaved.current?.trim() === vars.note) unsaved.current = null;
      void utils.timers.list.invalidate();
    },
  });
  const saveRef = useRef(save.mutate);
  useEffect(() => {
    saveRef.current = save.mutate;
  });

  // Follow server changes (other tab, timer switch) unless the user's text
  // is still on its way: a poll must never eat keystrokes.
  useEffect(() => {
    if (unsaved.current === null) setValue(v => (v.trim() === note ? v : note));
  }, [note]);

  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    if (unsaved.current !== null)
      saveRef.current({ issueKey, connectionId, note: unsaved.current.trim() });
  };
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  // Closing focus mode or stopping the timer right after typing still saves.
  useEffect(() => () => flushRef.current(), []);

  const change = (next: string) => {
    setValue(next);
    // Untrimmed: a trailing space while typing must survive the save.
    unsaved.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };

  return (
    <label className={cn("block", className)}>
      <span className="sr-only">{t("ui.timerNote.label", { key: issueKey })}</span>
      <input
        value={value}
        onChange={e => change(e.target.value)}
        onBlur={flush}
        onKeyDown={e => e.key === "Escape" && e.currentTarget.blur()}
        maxLength={500}
        placeholder={t("ui.timerNote.placeholder")}
        className={cn(
          "w-full rounded-md bg-transparent px-2 py-1 text-caption outline-none transition-colors placeholder:text-muted-foreground hover:bg-accent/60 focus:bg-background focus:ring-1 focus:ring-ring/30",
          inputClassName
        )}
      />
    </label>
  );
}
