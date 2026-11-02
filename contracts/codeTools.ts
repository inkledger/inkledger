import { z } from "zod";

/**
 * The code tools of the Desk's chat (docs/work/desk.md, batch 4d): a minimal read-only
 * set in the style of Pi (ls, find, grep, read) plus two git tools. The model asks for
 * them; the user's own machine runs them (the app's Rust commands, or a folder connected
 * in the browser), never the server. Shared by the page, the server and the tests.
 */
export const CODE_TOOLS = ["ls", "find", "grep", "read", "git_log", "git_show"] as const;
export type CodeToolName = (typeof CODE_TOOLS)[number];
/** What a folder connected in a browser can do (no git there). */
export const FILE_TOOLS: readonly CodeToolName[] = ["ls", "find", "grep", "read"];

/** Tool rounds per question; after the last the model gets no tools and must answer. */
export const MAX_TOOL_ROUNDS = 12;
/** A tool result as the model reads it (chars). */
export const TOOL_RESULT_CHARS = 12_000;
/** The automatic extracts sent with a question when the model can't use tools (chars). */
export const EXTRACTS_CHARS = 16_000;
export const READ_LINES = 400;
export const GREP_HITS = 40;
export const FIND_PATHS = 200;
export const LS_ENTRIES = 300;
export const GIT_LOG_MAX = 30;
/** Files bigger than this are not searched or read. */
export const FILE_BYTES_MAX = 1_000_000;
/** Files a search or find walks at most. */
export const WALK_FILES_MAX = 20_000;
/** A line of a hit or a read, as shown (chars). */
export const LINE_CHARS = 400;
/** Folders never walked: version control, dependencies, build output. */
export const SKIPPED_DIRS: readonly string[] = [".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit", ".gradle", ".idea", "coverage", "__pycache__", ".venv", "venv", "obj", ".turbo", ".cache"];

/**
 * A path inside a repository as its segments ([] for the root), or null when it could
 * leave it: absolute, a drive letter, home, `..`, control characters or `:` (Windows
 * streams). Backslashes are separators, as on Windows.
 */
const PRIVATE_DIRS = [".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws"];
const PRIVATE_FILES = [".npmrc", ".netrc", ".pypirc", ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const PRIVATE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template"];

/**
 * A file or folder the model never sees: version control (the git tools read history),
 * and what usually holds secrets (.env files, keys, credentials). Examples stay readable.
 * The same rules as `is_private` in src-tauri/src/code.rs.
 */
export function isPrivateName(name: string): boolean {
  const n = name.toLowerCase();
  if (PRIVATE_DIRS.includes(n) || PRIVATE_FILES.includes(n)) return true;
  if ((n === ".env" || n.startsWith(".env.")) && !ENV_EXAMPLES.includes(n)) return true;
  return PRIVATE_EXTENSIONS.some(ext => n.endsWith(ext));
}

export function repoPathParts(path: string): string[] | null {
  const p = path.trim().replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split("/").filter(s => s !== "" && s !== ".");
  if (parts[0] === "~") return null;
  if (parts.some(s => s === ".." || s.includes(":") || [...s].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))) return null;
  return parts;
}

/**
 * A glob over repository paths (`/` separated): `*` and `?` within a segment, `**` across
 * segments, `{a,b}` alternatives. Without a slash it matches the file name anywhere.
 */
export function globMatch(glob: string, path: string): boolean {
  const target = glob.includes("/") ? path : (path.split("/").pop() ?? path);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      // `**/` also matches no folder at all.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "{") re += "(?:";
    else if (ch === "}") re += ")";
    else if (ch === "," && re.lastIndexOf("(?:") > re.lastIndexOf(")")) re += "|";
    else re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`, "i").test(target);
  } catch {
    return false;
  }
}

// Models send numbers and booleans as strings now and then: read them leniently.
const int = (min: number, max: number) => z.preprocess(v => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number().int().min(min).max(max));
const flag = z.preprocess(v => v === true || v === "true", z.boolean());
const repo = z.union([z.string().trim().min(1).max(80), z.number().int().min(0).max(99)]);
const path = z.string().max(1000);

export const toolArgSchemas = {
  ls: z.object({ repo, path: path.default("") }),
  find: z.object({ repo, pattern: z.string().trim().min(1).max(200), path: path.default("") }),
  grep: z.object({ repo, query: z.string().min(1).max(200), regex: flag.optional(), glob: z.string().trim().max(200).optional() }),
  read: z.object({ repo, path: path.min(1), from: int(1, 10_000_000).optional(), to: int(1, 10_000_000).optional() }),
  git_log: z.object({ repo, grep: z.string().trim().max(200).optional(), path: path.optional(), limit: int(1, GIT_LOG_MAX).default(10) }),
  // Hex only: never an option, a range or a ref name the shell or git could read otherwise.
  git_show: z.object({ repo, commit: z.string().trim().regex(/^[0-9a-fA-F]{4,40}$/), path: path.optional() }),
} satisfies Record<CodeToolName, z.ZodType>;

export type ToolArgs = { [K in CodeToolName]: z.infer<(typeof toolArgSchemas)[K]> };

/** A call's arguments checked, or why they can't be run (said back to the model). */
export function parseToolArgs<K extends CodeToolName>(name: K, args: unknown): { ok: true; args: ToolArgs[K] } | { ok: false; error: string } {
  const parsed = toolArgSchemas[name].safeParse(args ?? {});
  if (parsed.success) return { ok: true, args: parsed.data as ToolArgs[K] };
  return { ok: false, error: parsed.error.issues.map(i => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ") };
}

export type LsResult = { path: string; entries: { name: string; dir: boolean }[]; truncated: boolean };
export type FindResult = { paths: string[]; truncated: boolean };
export type GrepResult = { hits: { path: string; line: number; text: string }[]; truncated: boolean; files: number };
export type ReadResult = { path: string; from: number; to: number; total: number; lines: string[] };
export type GitLogResult = { commits: { hash: string; date: string; subject: string; files: { status: string; path: string }[] }[] };
export type GitShowResult = { text: string; truncated: boolean };
export type ToolResults = { ls: LsResult; find: FindResult; grep: GrepResult; read: ReadResult; git_log: GitLogResult; git_show: GitShowResult };

/** Text cut to `max` characters, saying so. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = `\n(cut here: ${text.length - max} more characters)`;
  return text.slice(0, max - note.length) + note;
}

/** A tool's result as the model reads it: plain lines, capped at TOOL_RESULT_CHARS. */
export function formatToolResult<K extends CodeToolName>(name: K, result: ToolResults[K]): string {
  return capText(resultText(name, result), TOOL_RESULT_CHARS);
}

function resultText(name: CodeToolName, r: ToolResults[CodeToolName]): string {
  if (name === "ls" && "entries" in r) {
    const lines = r.entries.map(e => (e.dir ? `${e.name}/` : e.name));
    return [lines.join("\n") || "(empty folder)", ...(r.truncated ? ["(more entries)"] : [])].join("\n");
  }
  if (name === "find" && "paths" in r) return [r.paths.join("\n") || "(no match)", ...(r.truncated ? ["(more matches: narrow the pattern)"] : [])].join("\n");
  if (name === "grep" && "hits" in r) {
    const lines = r.hits.map(h => `${h.path}:${h.line}: ${h.text.trim()}`);
    return [lines.join("\n") || `(no match in ${r.files} files)`, ...(r.truncated ? ["(more hits: narrow the query or add a glob)"] : [])].join("\n");
  }
  if (name === "read" && "lines" in r) {
    const head = `${r.path}, lines ${r.from}–${r.to} of ${r.total}`;
    const more = r.to < r.total ? `\n(${r.total - r.to} more lines: read from ${r.to + 1})` : "";
    return `${head}\n${r.lines.map((l, i) => `${r.from + i}: ${l}`).join("\n")}${more}`;
  }
  if (name === "git_log" && "commits" in r)
    return r.commits.map(c => [`${c.hash} ${c.date} ${c.subject}`, ...c.files.map(f => `  ${f.status} ${f.path}`)].join("\n")).join("\n") || "(no commit)";
  if (name === "git_show" && "text" in r) return r.truncated ? `${r.text}\n(cut here: the commit goes on)` : r.text;
  return "";
}
