// The Desk's chat (docs/work/desk.md, batches 4c and 4d): a conversation about the issues
// shown on the desk, and the code the user's machine can read for it. English
// instructions, kept short and steady; the answer in the user's language.
import type { CodeToolName } from "@contracts/codeTools";
import type { OllamaToolDef } from "../ollama";

const LANGUAGE: Record<string, string> = { en: "English", it: "Italian" };

/** One line per tool: what the system prompt lists, and the tool's own description. */
const TOOL_LINES: Record<CodeToolName, string> = {
  ls: "list a folder of a repository",
  find: "find files whose path matches a glob (e.g. **/*Inventory*)",
  grep: "search text, or a regex, in a repository's files; hits come with line numbers",
  read: "read a file's lines, at most 400 a call (from, to)",
  git_log: "commits, by words in their message (grep) or by path, with the files each changed",
  git_show: "one commit's changes (its patch)",
};

// A plain string type: older Ollama versions refuse a list of types.
const repo = { type: "string", description: "A repository from the list in the instructions: its label or its number" };
const path = (what: string) => ({ type: "string", description: `${what}, relative to the repository root ("" for the root)` });
const PARAMETERS: Record<CodeToolName, { properties: Record<string, unknown>; required: string[] }> = {
  ls: { properties: { repo, path: path("The folder") }, required: ["repo"] },
  find: { properties: { repo, pattern: { type: "string", description: "A glob; without a slash it matches file names anywhere" }, path: path("The folder to look in") }, required: ["repo", "pattern"] },
  grep: {
    properties: {
      repo,
      query: { type: "string", description: "The text to look for (any case)" },
      regex: { type: "boolean", description: "The query is a regular expression" },
      glob: { type: "string", description: "Only files matching this glob (e.g. *.kt)" },
    },
    required: ["repo", "query"],
  },
  read: { properties: { repo, path: path("The file"), from: { type: "integer", description: "First line (1 is the first)" }, to: { type: "integer", description: "Last line" } }, required: ["repo", "path"] },
  git_log: {
    properties: { repo, grep: { type: "string", description: "Words of the commit message, e.g. an issue key" }, path: path("Only commits touching this path"), limit: { type: "integer", description: "How many commits, at most 30" } },
    required: ["repo"],
  },
  git_show: { properties: { repo, commit: { type: "string", description: "The commit's hash (hex)" }, path: path("Only this file's changes") }, required: ["repo", "commit"] },
};

/** The tools offered to the model, in Ollama's shape; the repositories are context, not schema. */
export function deskChatTools(names: readonly CodeToolName[]): OllamaToolDef[] {
  return names.map(name => ({ type: "function", function: { name, description: TOOL_LINES[name], parameters: { type: "object", ...PARAMETERS[name] } } }));
}

export type DeskChatCode =
  /** The model explores the code with these tools. */
  | { mode: "tools"; tools: readonly CodeToolName[]; repos: readonly string[] }
  /** The page searched the code itself (a model without tools). */
  | { mode: "extracts"; extracts: string }
  | { mode: "none" };

/** The system message: the rules, the code in reach, then the issues. */
export function deskChatSystem(issuesMarkdown: string, keys: readonly string[], code: DeskChatCode, locale: string): string {
  const rules = [
    "You help a person decide about the issues on their desk, given below as Markdown.",
    `The issue keys are: ${keys.join(", ")}. Quote every key exactly as written there, never another prefix or number.`,
    "Answer about these issues only: when a question is about something else, say briefly that you can only talk about them.",
    "Use only what the issues and the code you read say; when something isn't there, say so instead of guessing.",
  ];
  if (code.mode === "tools") {
    const git = code.tools.includes("git_log");
    rules.push(
      "You can read the person's code, read-only, with these tools:",
      ...code.tools.map(t => `- ${t}: ${TOOL_LINES[t]}`),
      `Repositories (the repo argument): ${code.repos.map((r, i) => `${i} = ${r}`).join(", ")}.`,
      git
        ? "Check the code before claiming something is solved: look for commits mentioning the key (git_log with grep), then the code they changed. Say what you checked, with paths."
        : "Check the code before claiming something is solved: grep for the key and the words of the title, then read the code around the hits. Say what you checked, with paths.",
      "Take a few steps at most, then answer.",
    );
  } else if (code.mode === "extracts") {
    rules.push(
      "The person's code was searched for the issue keys and the words of their titles; the extracts follow the issues. They are partial: say what they show and what they can't prove.",
    );
  } else {
    rules.push("You can't see the code: when asked about it, say so in one line.");
  }
  rules.push(
    "Be concise; use Markdown lists and short headings when they help.",
    `Reply in the language the person writes in; when unsure, in ${LANGUAGE[locale] ?? "English"}.`,
  );
  const extracts = code.mode === "extracts" ? `\n\n---\n\n## Extracts from the code\n\n${code.extracts}` : "";
  return `${rules.join("\n")}\n\n---\n\n${issuesMarkdown}${extracts}`;
}

/** Said when the tool rounds are used up: the model gets no tools and this. */
export const NO_STEPS_LEFT = "No steps left: answer now from what you found, and say what you could not check.";
