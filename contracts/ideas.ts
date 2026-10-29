// Ideas in triage (docs/work/ideas/triage.md): their states and moves, capture
// of a pasted list, and the texts an idea is handed on as (an agent's prompt, a mail).

export const IDEA_STATES = ["raw", "refining", "ready", "promoted", "discarded"] as const;
export type IdeaState = (typeof IDEA_STATES)[number];
export const IDEA_ROUTES = ["me", "agent", "ask"] as const;
export type IdeaRoute = (typeof IDEA_ROUTES)[number];

export type Criterion = { id: string; text: string };
export type Question = { id: string; text: string; answer: string; blocking: boolean };
export type MoveRefusal = "notReady.title" | "notReady.acceptance" | "notReady.questions" | "promoteThroughIssue" | "terminal";

/** What the texts of an idea are made of */
export type IdeaView = {
  id: number;
  title: string;
  body: string;
  state: IdeaState;
  acceptance: Criterion[];
  questions: Question[];
  container: { id: number; key: string; name: string } | null;
};

/** At most this many characters in a title; the rest of a captured line goes to the body */
export const TITLE_MAX = 200;
/** At most this many ideas in one capture */
export const CAPTURE_MAX = 50;
const MARKER = /^\s*(\d+[.)]|[-*•]|\[[ x]\])\s+/;

/** One idea per non-empty line, list markers dropped (R-2.2). */
export function splitIdeas(text: string): { title: string; body: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(MARKER, "").trim())
    .filter((line) => line !== "")
    .map((line) => ({ title: line.slice(0, TITLE_MAX).trim(), body: line.slice(TITLE_MAX).trim() }));
}

/** Why an idea isn't ready (R-2.3), or null when it is. */
export function notReady(idea: Pick<IdeaView, "title" | "acceptance" | "questions">): MoveRefusal | null {
  if (idea.title.trim().length < 3) return "notReady.title";
  if (idea.acceptance.length === 0) return "notReady.acceptance";
  if (idea.questions.some((q) => q.blocking && q.answer.trim() === "")) return "notReady.questions";
  return null;
}

/**
 * Whether an idea may go to `to` (R-2.1): promoted only through the issue it
 * becomes; promoted and discarded ones only reopen (to refining); ready is earned.
 */
export function canMove(idea: Pick<IdeaView, "state" | "title" | "acceptance" | "questions">, to: IdeaState): { ok: true } | { ok: false; reason: MoveRefusal } {
  if (to === idea.state) return { ok: true };
  if (to === "promoted") return { ok: false, reason: "promoteThroughIssue" };
  if ((idea.state === "promoted" || idea.state === "discarded") && to !== "refining") return { ok: false, reason: "terminal" };
  if (to === "ready") {
    const reason = notReady(idea);
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

const slug = (text: string, max: number) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");

/** The idea as a prompt for a coding agent, in the agreed shape (R-2.6). */
export function handoffPrompt(idea: IdeaView, issue: { key: string; url: string } | null): { markdown: string; filename: string } {
  const answered = idea.questions.filter((q) => q.answer.trim() !== "");
  const open = idea.questions.filter((q) => q.answer.trim() === "");
  const lines = [
    `# ${idea.title}`,
    ...(issue ? [`Issue: ${issue.key} ${issue.url}`] : []),
    ...(idea.container ? [`Project: ${idea.container.name}`] : []),
    "",
    "## Problem",
    idea.body,
    "",
    "## Acceptance criteria",
    ...idea.acceptance.map((c) => `- [ ] ${c.text}`),
    "",
    "## Decisions already taken",
    ...answered.map((q) => `- ${q.text} → ${q.answer}`),
    "",
    "## Open questions (ask before deciding)",
    ...open.map((q) => `- ${q.text}`),
    "",
    "## Constraints",
    "Follow the repository's CLAUDE.md and its checks. Do not push.",
    "",
  ];
  return { markdown: lines.join("\n"), filename: `idea-${idea.id}-${slug(idea.title, 40) || "untitled"}.md` };
}

/** Longest mail link most clients still open */
const MAILTO_MAX = 2000;

/** A mail asking the idea's open questions (R-2.6): at most 2000 characters, the questions that don't fit cut with "…". */
export function askMailUrl(idea: IdeaView, to: string | null): string {
  const head = `mailto:${to ? encodeURIComponent(to).replace(/%40/g, "@") : ""}?subject=${encodeURIComponent(idea.title)}&body=`;
  const open = idea.questions.filter((q) => q.answer.trim() === "").map((q) => `- ${q.text}`);
  for (let n = open.length; n >= 0; n--) {
    const body = [...open.slice(0, n), ...(n < open.length ? ["…"] : [])].join("\n");
    const url = head + encodeURIComponent(body);
    if (url.length <= MAILTO_MAX) return url;
  }
  return head.slice(0, MAILTO_MAX);
}
