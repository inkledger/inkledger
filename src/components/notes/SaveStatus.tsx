import { CloudOff } from "@/components/app/icons";
import { t } from "@/i18n";
import { timeOfDay } from "@/lib/dates";
import type { SaveState } from "./useNoteDocument";

export function SaveStatus({
  status,
  savedAt,
  storageUnavailable,
}: {
  status: SaveState;
  savedAt?: Date;
  storageUnavailable: boolean;
}) {
  const text = storageUnavailable
    ? t("pages.notes.storageUnavailable")
    : status === "saving"
      ? t("pages.notes.saving")
      : status === "saved"
        ? savedAt
          ? t("pages.notes.savedAt", { time: timeOfDay(savedAt) })
          : t("pages.notes.saved")
        : status === "offline"
          ? t("pages.notes.offline")
          : status === "error"
            ? t("pages.notes.saveError")
            : status === "conflict"
              ? t("pages.notes.conflict")
              : t("pages.notes.draft");
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex min-h-8 items-center gap-1.5 text-caption text-muted-foreground"
    >
      {status === "offline" && <CloudOff className="h-3.5 w-3.5" aria-hidden />}
      {text}
    </span>
  );
}
