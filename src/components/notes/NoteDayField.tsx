import { useId, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";
import { noteDay } from "./noteDay";

/**
 * The note's own day (a meeting's, even when written the day after): what the
 * diary and `data:` searches go by. Changed on its own, never with the text.
 */
export function NoteDayField({ noteId, notedOn, editable }: { noteId: string; notedOn: string | null; editable: boolean }) {
  const id = useId();
  const utils = trpc.useUtils();
  // The tree has the latest day (it is read again after a change); the one picked shows meanwhile.
  const tree = trpc.notes.tree.useQuery();
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? tree.data?.find(item => item.id === noteId)?.notedOn ?? notedOn ?? "";
  const set = trpc.notes.setDate.useMutation({
    onSuccess: () => void utils.notes.tree.invalidate().then(() => setPicked(null)),
    onError: (e: unknown) => {
      setPicked(null);
      toastError(e);
    },
  });
  if (!editable)
    return value ? (
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <CalendarDays aria-hidden className="h-3.5 w-3.5" />
        <span className="sr-only">{t("pages.notes.noteDay")}: </span>
        {noteDay(value)}
      </p>
    ) : null;
  return (
    <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
      <CalendarDays aria-hidden className="h-3.5 w-3.5" />
      <label htmlFor={id} className="sr-only">
        {t("pages.notes.noteDay")}
      </label>
      <Input
        id={id}
        type="date"
        value={value}
        title={t("pages.notes.noteDayHint")}
        disabled={set.isPending}
        onChange={event => {
          const next = event.target.value;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
          setPicked(next);
          set.mutate({ id: noteId, notedOn: next });
        }}
        className="h-7 w-auto border-0 px-1 text-caption shadow-none"
      />
    </div>
  );
}
