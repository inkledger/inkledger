import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/** The note kept on this device after a failed save, unless the server already has it. */
function readDraft(key: string, note: string): string | null {
  try {
    const d = localStorage.getItem(key);
    return d !== null && d.trim() !== note ? d : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, text: string | null) {
  try {
    if (text === null) localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch {
    // no storage (private window): the note stays in the field only
  }
}

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
  // A note the server refused is kept on this device until it is saved (closing the panel too).
  const draftKey = `ikl.timerNote.${connectionId ?? ""}:${issueKey}`;
  const [draft] = useState(() => readDraft(draftKey, note));
  const [value, setValue] = useState(draft ?? note);
  const [failed, setFailed] = useState(draft !== null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Text typed but not yet confirmed by the server. */
  const unsaved = useRef<string | null>(draft);
  /** One save on its way at a time: a slower earlier one can never land after a later one. */
  const inFlight = useRef(false);
  const send = useRef<() => void>(() => {});
  const save = trpc.timers.setNote.useMutation();
  useEffect(() => {
    send.current = () => {
      if (inFlight.current || unsaved.current === null) return;
      const text = unsaved.current;
      inFlight.current = true;
      save.mutate(
        { issueKey, connectionId, note: text.trim() },
        {
          onSuccess: () => {
            if (unsaved.current === text) unsaved.current = null;
            writeDraft(draftKey, null);
            setFailed(false);
            void utils.timers.list.invalidate();
          },
          // Kept (never lost): said, and sent again with the next change or blur.
          onError: () => {
            writeDraft(draftKey, unsaved.current ?? text);
            setFailed(true);
          },
          onSettled: () => {
            inFlight.current = false;
            // Typed meanwhile: the newest text goes now.
            if (unsaved.current !== null && unsaved.current !== text) send.current();
          },
        }
      );
    };
  });

  // Follow server changes (other tab, timer switch) unless the user's text
  // is still on its way: a poll must never eat keystrokes.
  useEffect(() => {
    if (unsaved.current === null) setValue(v => (v.trim() === note ? v : note));
  }, [note]);

  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    send.current();
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
        aria-invalid={failed || undefined}
        className={cn(
          "w-full rounded-md bg-transparent px-2 py-1 text-caption outline-none transition-colors placeholder:text-muted-foreground hover:bg-accent/60 focus:bg-background focus-visible:ring-1 focus-visible:ring-ring",
          inputClassName
        )}
      />
      {failed && (
        <span role="alert" className="block px-2 text-caption text-danger">
          {t("ui.timerNote.notSaved")}
        </span>
      )}
    </label>
  );
}
