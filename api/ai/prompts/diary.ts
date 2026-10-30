// "Summary" and "Timeline" in the diary: the days written up by the local model.
import { diaryInstructions, type DiaryMode } from "@contracts/diary";
import type { OllamaMessage } from "../ollama";

export function diaryPrompt(markdown: string, mode: DiaryMode, locale: string, fromDay: string, toDay: string): OllamaMessage[] {
  return [
    { role: "system", content: `${diaryInstructions(mode, locale, fromDay, toDay)} Return only JSON matching the schema: the document as Markdown in "markdown".` },
    { role: "user", content: markdown },
  ];
}
