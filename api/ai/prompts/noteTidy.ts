// "Tidy up with AI" on a note.
import { tidyInstructions } from "@contracts/noteTidy";
import type { OllamaMessage } from "../ollama";

export function noteTidyPrompt(title: string, body: string, locale: string): OllamaMessage[] {
  return [
    { role: "system", content: `${tidyInstructions(locale)} Return only JSON matching the schema: the whole tidied note as Markdown in "markdown", without its title.` },
    { role: "user", content: `${title ? `Title: ${title}\n\n` : ""}${body}` },
  ];
}
