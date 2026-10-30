// The prompt behind "Suggest" on an idea (docs/work/ideas/triage.md R-2.8):
// English instructions, the answer in the user's language.
import type { OllamaMessage } from "../ollama";

const LANGUAGE: Record<string, string> = { en: "English", it: "Italian" };

export function ideaPrompt(
  idea: { title: string; body: string; acceptance: { text: string }[]; questions: { text: string; answer: string }[]; container: { name: string } | null },
  locale: string,
): OllamaMessage[] {
  const known = [
    `Title: ${idea.title}`,
    ...(idea.container ? [`Project: ${idea.container.name}`] : []),
    ...(idea.body.trim() ? ["", idea.body.trim()] : []),
    ...(idea.acceptance.length ? ["", "Done when:", ...idea.acceptance.map((c) => `- ${c.text}`)] : []),
    ...(idea.questions.length ? ["", "Questions:", ...idea.questions.map((q) => `- ${q.text}${q.answer ? ` → ${q.answer}` : ""}`)] : []),
  ];
  return [
    {
      role: "system",
      content:
        "You help turn a raw idea into an actionable issue for a software project. Return only JSON matching the schema: " +
        "a clearer title; the problem in 2-4 sentences; testable acceptance criteria; what is out of scope; the questions to ask " +
        "before starting (only ones not answered already); a split into smaller ideas only when it is big; a few short labels; " +
        "a rough estimate in minutes. Do not invent facts the idea doesn't give: ask instead. " +
        `Answer in ${LANGUAGE[locale] ?? "English"}.`,
    },
    { role: "user", content: known.join("\n") },
  ];
}
