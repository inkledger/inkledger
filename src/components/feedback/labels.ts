import type { FeedbackStatus, FeedbackType } from "@contracts/feedback";
import type { Tone } from "@/lib/jira";
import { t } from "@/i18n";

/** A feedback's state in words. */
export const statusLabel = (s: string): string =>
  (["new", "discussion", "accepted", "in_progress", "implemented", "rejected"] as const).includes(s as FeedbackStatus) ? t(`pages.feedback.statuses.${s as FeedbackStatus}`) : s;

/** A feedback's kind in words. */
export const typeLabel = (s: string): string => ((["problem", "idea", "improvement"] as const).includes(s as FeedbackType) ? t(`pages.feedback.types.${s as FeedbackType}`) : s);

/** The dot of a state in a list: done is success, rejected danger, under way info, new neutral. */
export function statusTone(s: string): Tone {
  switch (s) {
    case "implemented":
      return "success";
    case "rejected":
      return "danger";
    case "accepted":
    case "in_progress":
      return "info";
    case "discussion":
      return "warning";
    default:
      return "neutral";
  }
}

/** The look the page is drawn in, as the feedback records it: "dark·soft·high". */
export function currentLook(): string {
  if (typeof document === "undefined") return "";
  const root = document.documentElement;
  const theme = root.classList.contains("dark") ? "dark" : "light";
  return [theme, root.dataset.variant || "standard", root.dataset.contrast || "normal"].join("·");
}

/** The density the page is drawn in. */
export const currentDensity = (): "compact" | "comfortable" =>
  typeof document !== "undefined" && document.documentElement.dataset.density === "comfortable" ? "comfortable" : "compact";
