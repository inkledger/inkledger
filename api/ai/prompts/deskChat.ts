// The Desk's chat (docs/work/desk.md, batch 4c): a conversation about the issues
// shown on the desk. English instructions, the answer in the user's language.
import type { DeskChatTurn } from "@contracts/deskChat";
import type { OllamaChatMessage } from "../ollama";

const LANGUAGE: Record<string, string> = { en: "English", it: "Italian" };

export function deskChatPrompt(issuesMarkdown: string, conversation: readonly DeskChatTurn[], locale: string): OllamaChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You help a person decide about the issues on their desk, given below as Markdown. " +
        "Answer about these issues only: when a question is about something else, say briefly that you can only talk about them. " +
        "Use only what the issues say; when something isn't there, say so instead of guessing. " +
        "Cite the issue keys you rely on (for example APP-12). Be concise; use Markdown lists and short headings when they help. " +
        `Reply in the language the person writes in; when unsure, in ${LANGUAGE[locale] ?? "English"}.\n\n` +
        `---\n\n${issuesMarkdown}`,
    },
    ...conversation.map(turn => ({ role: turn.role, content: turn.content })),
  ];
}
