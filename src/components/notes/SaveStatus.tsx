import { CloudOff } from "lucide-react";
import { t, dateFormat } from "@/i18n";
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
          ? t("pages.notes.savedAt", {
              time: dateFormat({ hour: "2-digit", minute: "2-digit" }).format(
                new Date(savedAt)
              ),
            })
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
