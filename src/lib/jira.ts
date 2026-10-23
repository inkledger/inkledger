import { t } from "@contracts/i18n";
import { isWaiting } from "@contracts/categories";
/** Duration presets offered when logging time. */
export const DURATION_PRESETS = ["15m", "30m", "1h", "2h", "4h", "1d"] as const;

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** Chip tone for a status, by its canonical category: only work in progress and done stand out. */
export function statusCategoryTone(category: string): Tone {
  if (category === "done") return "success";
  if (category === "doing") return "warning";
  return "neutral";
}

/** Board column dot: red waiting (triage, backlog, to do), amber in progress, green done, grey cancelled. */
export function statusCategoryDotTone(category: string): Tone {
  if (isWaiting(category)) return "danger";
  return statusCategoryTone(category);
}

export function priorityLabel(priority: string): string {
  switch (priority) {
    case "Highest":
      return t("ui.priority.highest");
    case "High":
      return t("ui.priority.high");
    case "Medium":
      return t("ui.priority.medium");
    case "Low":
      return t("ui.priority.low");
    case "Lowest":
      return t("ui.priority.lowest");
    case "Blocker":
      return t("ui.priority.blocker");
    case "Critical":
      return t("ui.priority.critical");
    case "Major":
      return t("ui.priority.major");
    case "Minor":
      return t("ui.priority.minor");
    case "Trivial":
      return t("ui.priority.trivial");
    default:
      return priority;
  }
}

// Jira Server/DC often uses localized or custom priority names.
const URGENT = [
  "Highest",
  "High",
  "Blocker",
  "Critical",
  "Critica",
  "Urgente",
  "Bloccante",
  "Alta",
  "Massima",
];
const NORMAL = ["Medium", "Major", "Normale", "Media", "Maggiore"];
const LOW = [
  "Low",
  "Lowest",
  "Minor",
  "Trivial",
  "Bassa",
  "Minima",
  "Minore",
  "Banale",
];

/** A level as the Board's URL keeps it: "0"…"4", or "none" for issues without a priority. */
export const levelKey = (level: number | null) => (level === null ? "none" : String(level));

/** A priority level's tone (0 highest … 4 lowest; null: none). */
export function toneOfLevel(level: number | null): Tone {
  if (level === null) return "neutral";
  return level <= 1 ? "danger" : level === 2 ? "info" : "success";
}

export function priorityTone(priority: string): Tone {
  if (URGENT.includes(priority)) return "danger";
  if (NORMAL.includes(priority)) return "info";
  if (LOW.includes(priority)) return "success";
  return "neutral";
}
