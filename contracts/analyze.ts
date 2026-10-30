// "Analyse" on an issue: a command the user runs in a terminal, that starts a
// coding agent in the project's repositories with the issue as its prompt.
// Nothing runs here: the command is only copied. Everything in it that comes
// from data (paths, the issue's text) is one single-quoted shell word, so no
// text in an issue can end it and run something else (a heredoc could be
// closed by a line of the issue).

/** A path the command can `cd` into: absolute or from home, one line, no control characters. */
export function isRepoPath(path: string): boolean {
  return /^(\/|~\/)/.test(path) && path.length <= 1000 && ![...path].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
}

/** One shell word, taken literally by sh, bash and zsh: '…', each ' written '\''. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A path as a shell word; `~/` stays outside the quotes, so the shell still expands it. */
export function shellPath(path: string): string {
  return path.startsWith("~/") ? `~/${shellWord(path.slice(2))}` : shellWord(path);
}

/** The agent command as written in the settings: a program and its options, one line. */
export function isAgentCommand(command: string): boolean {
  return command.trim().length > 0 && command.length <= 200 && !/[\n\r;&|`$<>]/.test(command);
}

/** What the agent is asked to do with the issue (the issue as copied for an agent follows). */
export function analyzeInstructions(repos: { label: string; path: string }[]): string {
  const list = repos.map(r => `- ${r.label ? `${r.label}: ` : ""}${r.path}`).join("\n");
  return [
    "Analyse this issue against the code in these repositories:",
    list,
    "",
    "Find the cause or the place to change, the files and functions involved in each repository, and the risks. Propose a short plan. Do not modify any file: analysis only.",
  ].join("\n");
}

/**
 * The command: into the first repository, the others added to the agent's reach
 * (Claude Code's --add-dir), the prompt as the last word.
 */
export function analyzeCommand(agent: string, repos: { label: string; path: string }[], prompt: string): string {
  const [first, ...rest] = repos;
  const claude = /^claude(\s|$)/.test(agent.trim());
  const dirs = claude ? rest.map(r => ` --add-dir ${shellPath(r.path)}`).join("") : "";
  return `cd ${shellPath(first.path)} && ${agent.trim()}${dirs} ${shellWord(prompt)}`;
}
