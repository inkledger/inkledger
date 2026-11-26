import {
  FILE_BYTES_MAX,
  FIND_PATHS,
  GREP_HITS,
  LINE_CHARS,
  LS_ENTRIES,
  READ_LINES,
  SKIPPED_DIRS,
  WALK_FILES_MAX,
  globMatch,
  parseToolArgs,
  isPrivateName,
  repoPathParts,
  type CodeToolName,
  type ToolResults,
} from "@contracts/codeTools";

/**
 * The code tools in a browser (docs/work/desk.md, batch 4d): ls, find, grep and read over a
 * folder the user connected with the File System Access API. Everything goes through the
 * folder's handle, so nothing outside it can be named; paths are still checked
 * (`repoPathParts`) so a bad one says why. No git here: the app has it.
 */

/** The part of FileSystemFileHandle used here. */
export type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> };
/** The part of FileSystemDirectoryHandle used here (an in-memory one in tests and e2e). */
export type DirHandle = {
  kind: "directory";
  name: string;
  entries(): AsyncIterable<[string, { kind: "file" | "directory" }]>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
};

export type ToolOutcome = { ok: true; result: ToolResults[CodeToolName] } | { ok: false; error: string };

class ToolFailure extends Error {}
const fail = (message: string): never => {
  throw new ToolFailure(message);
};
const stopped = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
};

async function children(dir: DirHandle): Promise<{ name: string; dir: boolean }[]> {
  const out: { name: string; dir: boolean }[] = [];
  for await (const [name, handle] of dir.entries()) if (!isPrivateName(name)) out.push({ name, dir: handle.kind === "directory" });
  // Folders first, then by name: the same order every time.
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function partsOf(path: string): string[] {
  const parts = repoPathParts(path) ?? fail(`"${path}" leaves the repository: use a path relative to its root, without ..`);
  if (parts.some(isPrivateName)) fail(`"${path}" is private (version control or secrets): it is never read`);
  return parts;
}

async function dirAt(root: DirHandle, parts: readonly string[]): Promise<DirHandle> {
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part).catch(() => fail(`no folder ${parts.join("/")}`));
  return dir;
}

/** A text file's content, or why it can't be read (too big, binary). */
async function textOf(file: File, path: string): Promise<string> {
  if (file.size > FILE_BYTES_MAX) fail(`${path} is too big to read (${Math.round(file.size / 1000)} KB)`);
  const head = new Uint8Array(await file.slice(0, 8000).arrayBuffer());
  if (head.includes(0)) fail(`${path} is not a text file`);
  return file.text();
}

/** A file's lines, CRLF or LF, without the empty one after a last newline. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const clip = (line: string) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line);

/** A regular expression runs in the page, where nothing can stop it: its shape is bounded instead. */
const REGEX_QUANTIFIERS = 3;
/** The ways the bounded repetitions (?, {n,m}) together can match, at most. */
const REGEX_CHOICES = 256;
const REGEX_LINE_CHARS = 1_000;
const REGEX_BUDGET_MS = 2_000;

/**
 * Why a pattern could take the page for minutes (catastrophic backtracking), or null: a
 * backreference; a repeated group that repeats or alternates inside (at any depth); more
 * than a few open-ended repetitions, or too many optional parts, in all.
 */
export function slowPattern(source: string): string | null {
  const groups: { repeats: boolean; alternates: boolean }[] = [{ repeats: false, alternates: false }];
  let openEnded = 0;
  let choices = 1;
  // The atom just before, when it repeats without end, and whether it was counted. A run on one
  // escape (\w+, \s*) or one character backtracks only against a neighbour it overlaps: \w+\s*=\s*\w+
  // is linear, \s*\s*\s* is not. Any dot, class or group counts as before.
  let prev: { atom: string; counted: boolean } | null = null;
  const overlaps = (a: string, b: string) =>
    a === b || a === "." || b === "." || !/^\\?[^\\]$/.test(a) || !/^\\?[^\\]$/.test(b) || (a.length === 1) !== (b.length === 1) || (/^\\[wd]$/.test(a) && /^\\[wd]$/.test(b)) || (/^\\[WSD]$/.test(a) && /^\\[WSD]$/.test(b));
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    let atom = ch;
    const top = groups[groups.length - 1];
    // What follows position `at`: a quantifier's length (0: none), whether it is open-ended, the ways it can match.
    const quantifier = (at: number): { length: number; open: boolean; ways: number } => {
      const q = source[at];
      if (q === "*" || q === "+") return { length: 1 + (source[at + 1] === "?" ? 1 : 0), open: true, ways: 1 };
      if (q === "?") return { length: 1 + (source[at + 1] === "?" ? 1 : 0), open: false, ways: 2 };
      const m = q === "{" ? /^\{(\d+)(,(\d*))?\}\??/.exec(source.slice(at)) : null;
      if (!m) return { length: 0, open: false, ways: 1 };
      const open = m[2] !== undefined && (m[3] === "" || Number(m[3]) - Number(m[1]) > 10);
      return { length: m[0].length, open, ways: m[2] !== undefined && !open ? Number(m[3]) - Number(m[1]) + 1 : 1 };
    };
    if (ch === "\\") {
      if (/[1-9k]/.test(source[i + 1] ?? "")) return "it refers back to a group";
      atom = `\\${source[i + 1] ?? ""}`;
      i++;
    } else if (ch === "[") {
      atom = "[]";
      for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
    } else if (ch === "(") {
      prev = null;
      groups.push({ repeats: false, alternates: false });
      // (?:…), lookarounds, named groups: their opening "?" is no repetition.
      i += /^\?(?:[:=!]|<[=!]|<[^>]*>)/.exec(source.slice(i + 1))?.[0].length ?? 0;
      continue;
    } else if (ch === "|") top.alternates = true;
    else if (ch === ")" && groups.length > 1) {
      groups.pop();
      const q = quantifier(i + 1);
      if (q.length && (top.repeats || top.alternates)) return "a repeated group repeats or alternates inside";
      const parent = groups[groups.length - 1];
      if (q.length || top.repeats) parent.repeats = true;
      if (top.alternates) parent.alternates = true;
      if (q.open) openEnded++;
      choices *= q.ways;
      i += q.length;
      prev = q.open ? { atom: "()", counted: true } : null;
      continue;
    }
    const q = ch === ")" ? { length: 0, open: false, ways: 1 } : quantifier(i + 1);
    if (q.length) {
      top.repeats = true;
      if (q.open) {
        const single = /^\\?[^\\]$/.test(atom) && atom !== ".";
        // Counted alone when it can't run on its own (a dot, a class), else when it overlaps the run before it (both then).
        const counted: boolean = !single || (prev !== null && overlaps(prev.atom, atom));
        if (counted) openEnded += prev && single && !prev.counted ? 2 : 1;
        prev = { atom, counted };
      } else prev = null;
      choices *= q.ways;
      i += q.length;
    } else prev = null;
  }
  if (openEnded > REGEX_QUANTIFIERS) return `more than ${REGEX_QUANTIFIERS} open-ended repetitions`;
  return choices > REGEX_CHOICES ? "too many optional parts" : null;
}

/**
 * Every file under `start` (folders skipped by SKIPPED_DIRS), depth first in name order,
 * files before subfolders; at most WALK_FILES_MAX. The page gets a turn now and then.
 */
async function* walk(start: DirHandle, prefix: string, signal: AbortSignal | undefined, count = { files: 0 }): AsyncGenerator<{ path: string; handle: () => Promise<FileHandle> }> {
  const list = await children(start);
  for (const entry of list.filter(e => !e.dir)) {
    stopped(signal);
    if (++count.files > WALK_FILES_MAX) return;
    if (count.files % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    yield { path: prefix + entry.name, handle: () => start.getFileHandle(entry.name) };
  }
  for (const entry of list.filter(e => e.dir && !SKIPPED_DIRS.includes(e.name))) {
    stopped(signal);
    if (count.files > WALK_FILES_MAX) return;
    yield* walk(await start.getDirectoryHandle(entry.name), `${prefix}${entry.name}/`, signal, count);
  }
}

/** Runs one tool on a connected folder; a refusal or a missing file is an outcome, Stop throws. */
export async function browserTool(root: DirHandle, name: CodeToolName, rawArgs: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
  stopped(signal);
  try {
    return { ok: true, result: await run(root, name, rawArgs, signal) };
  } catch (e) {
    if (e instanceof ToolFailure) return { ok: false, error: e.message };
    throw e;
  }
}

async function run(root: DirHandle, name: CodeToolName, rawArgs: unknown, signal?: AbortSignal): Promise<ToolResults[CodeToolName]> {
  if (name === "git_log" || name === "git_show") return fail("git isn't available for a folder connected in the browser: use ls, find, grep and read");
  if (name === "ls") {
    const args = parseToolArgs("ls", rawArgs);
    if (!args.ok) return fail(args.error);
    const parts = partsOf(args.args.path);
    const list = await children(await dirAt(root, parts));
    return { path: parts.join("/"), entries: list.slice(0, LS_ENTRIES), truncated: list.length > LS_ENTRIES };
  }
  if (name === "find") {
    const args = parseToolArgs("find", rawArgs);
    if (!args.ok) return fail(args.error);
    const parts = partsOf(args.args.path);
    const prefix = parts.length ? `${parts.join("/")}/` : "";
    const paths: string[] = [];
    for await (const file of walk(await dirAt(root, parts), prefix, signal)) {
      if (!globMatch(args.args.pattern, file.path)) continue;
      if (paths.length === FIND_PATHS) return { paths, truncated: true };
      paths.push(file.path);
    }
    return { paths, truncated: false };
  }
  if (name === "grep") {
    const args = parseToolArgs("grep", rawArgs);
    if (!args.ok) return fail(args.error);
    const { query, regex, glob } = args.args;
    let test: (line: string) => boolean;
    let overBudget = () => false;
    if (regex) {
      let re: RegExp;
      try {
        re = new RegExp(query, "i");
      } catch {
        return fail(`"${query}" is not a valid regular expression`);
      }
      const slow = slowPattern(query);
      if (slow) return fail(`"${query}" could take too long (${slow}): use a simpler expression, or a plain search`);
      // Only the time inside the expression counts (reading the folder is not its cost); past the
      // budget the search ends with what it found, marked cut short.
      let spent = 0;
      test = line => {
        if (spent > REGEX_BUDGET_MS) return false;
        const t0 = performance.now();
        const hit = re.test(line.slice(0, REGEX_LINE_CHARS));
        spent += performance.now() - t0;
        return hit;
      };
      overBudget = () => spent > REGEX_BUDGET_MS;
    } else {
      const needle = query.toLowerCase();
      test = line => line.toLowerCase().includes(needle);
    }
    const hits: ToolResults["grep"]["hits"] = [];
    let files = 0;
    for await (const file of walk(root, "", signal)) {
      if (glob && !globMatch(glob, file.path)) continue;
      const handle = await file.handle();
      const text = await textOf(await handle.getFile(), file.path).catch((e: unknown) => {
        if (e instanceof ToolFailure) return null;
        throw e;
      });
      if (text === null) continue;
      files++;
      const lines = linesOf(text);
      for (let i = 0; i < lines.length; i++) {
        if (!test(lines[i])) {
          if (overBudget()) return { hits, truncated: true, files };
          continue;
        }
        if (hits.length === GREP_HITS) return { hits, truncated: true, files };
        hits.push({ path: file.path, line: i + 1, text: clip(lines[i]) });
      }
    }
    return { hits, truncated: false, files };
  }
  const args = parseToolArgs("read", rawArgs);
  if (!args.ok) return fail(args.error);
  const parts = partsOf(args.args.path);
  if (!parts.length) return fail("read takes a file: use ls for a folder");
  const path = parts.join("/");
  const dir = await dirAt(root, parts.slice(0, -1));
  const handle = await dir.getFileHandle(parts[parts.length - 1]).catch(() => fail(`no file ${path}`));
  const lines = linesOf(await textOf(await handle.getFile(), path));
  const from = args.args.from ?? 1;
  if (from > lines.length) return fail(`${path} has ${lines.length} lines`);
  const to = Math.min(lines.length, args.args.to ?? from + READ_LINES - 1, from + READ_LINES - 1);
  return { path, from, to: Math.max(from, to), total: lines.length, lines: lines.slice(from - 1, Math.max(from, to)).map(clip) };
}
