import { dateFormat } from "@/i18n";

/** A moment on the issue (created, updated, a worklog), with its weekday. */
export const dateTime = () =>
  dateFormat({
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

