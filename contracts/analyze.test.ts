import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeCommand, isAgentCommand, isRepoPath, shellPath, shellWord } from "./analyze";

/** What the shell makes of `word`: the exact text, printed back. */
const through = (shell: string, word: string) => execFileSync(shell, ["-c", `printf %s ${word}`], { encoding: "utf8" });

const NASTY = [
  "it's broken",
  "$(touch /tmp/ikl-pwned) `id` ${HOME} $HOME",
  "line one\nEOF\nIKL_EOF\n'; rm -rf / #\n)",
  "unbalanced ) and ( and ' and \" and \\ and !",
  "émoji 🚀 and tabs\tand \\n",
];

describe("analyze: a command copied, never run here", () => {
  it("any text is one word, given back exactly by sh, bash and zsh-like shells", () => {
    for (const text of NASTY) for (const shell of ["/bin/sh", "/bin/bash"]) expect(through(shell, shellWord(text))).toBe(text);
  });

  it("paths: spaces and quotes kept, ~/ still expanded", () => {
    expect(through("/bin/sh", shellPath("/Users/me/My 'Apps'/app"))).toBe("/Users/me/My 'Apps'/app");
    expect(through("/bin/sh", shellPath("~/code/app"))).toBe(`${process.env.HOME}/code/app`);
    expect(isRepoPath("~/code/app")).toBe(true);
    expect(isRepoPath("relative/path")).toBe(false);
    expect(isRepoPath("/ok\n/rm")).toBe(false);
    expect(isRepoPath("C:\\code")).toBe(false);
  });

  it("the whole command parses, the prompt one word whatever it holds", () => {
    const cmd = analyzeCommand("claude", [{ label: "app", path: "/r/app" }, { label: "server", path: "~/r/my server" }], NASTY.join("\n"));
    expect(cmd.startsWith("cd '/r/app' && claude --add-dir ~/'r/my server' '")).toBe(true);
    execFileSync("/bin/bash", ["-n", "-c", cmd]);
    // The prompt as the agent would get it (the last word), and nothing in it ran.
    rmSync("/tmp/ikl-pwned", { force: true });
    const one = analyzeCommand("claude", [{ label: "app", path: "/r/app" }], NASTY.join("\n"));
    const echoed = execFileSync("/bin/bash", ["-c", one.replace("cd '/r/app' && claude ", "printf %s ")], { encoding: "utf8" });
    expect(echoed).toBe(NASTY.join("\n"));
    expect(existsSync("/tmp/ikl-pwned")).toBe(false);
    // Another agent: no --add-dir.
    expect(analyzeCommand("ollama run llama3", [{ label: "", path: "/r/app" }, { label: "", path: "/r/b" }], "x")).toBe("cd '/r/app' && ollama run llama3 'x'");
  });

  it("the agent command is a program and its options, nothing chained", () => {
    expect(isAgentCommand("claude --model opus")).toBe(true);
    for (const bad of ["claude; rm -rf ~", "claude && x", "claude | sh", "claude $(x)", "claude `x`", "claude\nx", ""]) expect(isAgentCommand(bad)).toBe(false);
  });
});
