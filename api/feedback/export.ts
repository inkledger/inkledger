// Feedback as files to read elsewhere (Feedback > Export): Markdown for people, JSON
// for tools. A data format, the same in every language: its labels are field names.
import type { CommentView, FeedbackView } from "./store";

export type ExportItem = FeedbackView & { comments: CommentView[] };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** One feedback as JSON: its fields and thread (no screenshot bytes). */
function plainOf(f: ExportItem) {
  return {
    id: f.id,
    type: f.type,
    status: f.status,
    statusReason: f.statusReason,
    title: f.title,
    body: f.body,
    author: f.authorName,
    page: f.page,
    appVersion: f.appVersion,
    look: f.look,
    density: f.density,
    hasScreenshot: f.hasScreenshot,
    shared: f.shareState,
    createdAt: iso(f.createdAt),
    updatedAt: iso(f.updatedAt),
    thread: f.comments.map((c) => ({ at: iso(c.createdAt), origin: c.origin, author: c.authorName || null, body: c.body, from: c.statusFrom, to: c.statusTo })),
  };
}

export function feedbackJson(items: ExportItem[], now = new Date()): string {
  return JSON.stringify({ format: "inkledger-feedback/1", generatedAt: now.toISOString(), items: items.map(plainOf) }, null, 2) + "\n";
}

/** A line of user text kept inside its block: no heading or rule of its own. */
const quote = (s: string) => (s.trim() ? s.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n") : "> (empty)");

export function feedbackMarkdown(items: ExportItem[], now = new Date()): string {
  const out = [`# Feedback (${items.length})`, "", `Generated ${now.toISOString()}`, ""];
  for (const f of items) {
    const p = plainOf(f);
    out.push(`## #${p.id} · ${p.type} · ${p.title.replace(/\s+/g, " ")}`, "");
    out.push(`- status: ${p.status}${p.statusReason ? ` (${p.statusReason.replace(/\s+/g, " ")})` : ""}`);
    out.push(`- author: ${p.author || "-"}`, `- created: ${p.createdAt}`, `- page: ${p.page || "-"}`, `- app: ${p.appVersion || "-"} · look: ${p.look || "-"} · density: ${p.density || "-"}`);
    if (p.shared) out.push(`- shared with the developers: ${p.shared}`);
    if (p.hasScreenshot) out.push("- screenshot: yes (not included)");
    out.push("", quote(p.body), "");
    if (p.thread.length) {
      out.push("### Thread", "");
      for (const c of p.thread) {
        const who = c.origin === "upstream" ? "inkledger developers" : c.author || "-";
        const what = c.to ? `status ${c.from ?? "?"} → ${c.to}${c.body ? `: ${c.body.replace(/\s+/g, " ")}` : ""}` : c.body.replace(/\s+/g, " ");
        out.push(`- ${c.at} · ${who} (${c.origin}): ${what}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}
