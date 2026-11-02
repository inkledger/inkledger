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

/** First meaningful line of a Jira description, without wiki markup. */
export function descriptionSnippet(text: string | undefined): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map(l =>
      l
        .replace(/\{[a-z]+(:[^}]*)?\}/gi, "")
        .replace(/^h[1-6]\.\s*/i, "")
        .replace(/[*_+]/g, "")
        .replace(/!([^!|]+)(\|[^!]*)?!/g, "")
        .replace(/\[([^|\]]+)\|[^\]]+\]/g, "$1")
        .trim()
    )
    .find(l => l.length > 0);
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}
