//! The Desk chat's code tools on this computer (docs/work/desk.md, batch 4d): read-only
//! `ls`, `find`, `grep`, `read`, `git_log` and `git_show` over the repositories attached
//! to a project. The page names a repository by the path set in Settings; since a
//! remote page could name any folder, each repository root must first be allowed by the
//! user in a native dialog (`code_allow_root`), and the allowance is kept in the app's
//! data, per server. Every path is relative to the root and stays inside it: absolute
//! paths, `..` and links that lead out are refused. Git runs as the `git` program with
//! fixed arguments and no shell; commit ids are hex only; without git the git tools are off.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Webview};
use tauri_plugin_store::StoreExt;

use crate::i18n::{fault, tr, trf};

const STORE: &str = "code-access.json";
const KEY: &str = "roots";

// The limits of contracts/codeTools.ts (the page caps the text the model reads again).
const READ_LINES: usize = 400;
const GREP_HITS: usize = 40;
const FIND_PATHS: usize = 200;
const LS_ENTRIES: usize = 300;
const GIT_LOG_MAX: u32 = 30;
const FILE_BYTES_MAX: u64 = 1_000_000;
const WALK_FILES_MAX: usize = 20_000;
const LINE_CHARS: usize = 400;
const SHOW_CHARS: usize = 11_000;
const GIT_OUTPUT_BYTES: usize = 256 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const WALK_TIME: Duration = Duration::from_secs(10);
const SKIPPED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".gradle",
    ".idea",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    "obj",
    ".turbo",
    ".cache",
];

// ---------------------------------------------------------------------------
// Paths

/// The home folder (`~`): HOME, or USERPROFILE on Windows.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).filter(|p| p.is_absolute())
}

/// `\\?\C:\x` (what canonicalize gives on Windows) as `C:\x`, which git and people read.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

/// A repository root as set in Settings (absolute, or from home with `~/`), resolved to
/// the real folder it is.
fn resolve_root(raw: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let raw = raw.trim();
    let path = if raw == "~" {
        home.map(Path::to_path_buf)
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home.map(|h| h.join(rest))
    } else {
        Some(PathBuf::from(raw))
    };
    let path = path.filter(|p| p.is_absolute()).ok_or_else(|| trf("code.bad_root", &[("path", raw)]))?;
    let real = std::fs::canonicalize(&path).map_err(|_| trf("code.no_root", &[("path", raw)]))?;
    if !real.is_dir() {
        return Err(trf("code.no_root", &[("path", raw)]));
    }
    let real = plain(real);
    // A whole disk or the home folder would put every file of this computer in reach.
    let home = home.and_then(|h| std::fs::canonicalize(h).ok()).map(plain);
    if real.parent().is_none() || home.as_deref() == Some(real.as_path()) {
        return Err(trf("code.broad_root", &[("path", raw)]));
    }
    Ok(real)
}

const PRIVATE_DIRS: &[&str] = &[".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws"];
const PRIVATE_FILES: &[&str] = &[".npmrc", ".netrc", ".pypirc", ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const PRIVATE_EXTENSIONS: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const ENV_EXAMPLES: &[&str] = &[".env.example", ".env.sample", ".env.template"];

/// A file or folder the model never sees: version control (the git tools read history)
/// and what usually holds secrets (.env files, keys, credentials); examples stay readable.
/// The same rules as `isPrivateName` in contracts/codeTools.ts.
fn is_private(name: &str) -> bool {
    let n = name.to_lowercase();
    if PRIVATE_DIRS.contains(&n.as_str()) || PRIVATE_FILES.contains(&n.as_str()) {
        return true;
    }
    if (n == ".env" || n.starts_with(".env.")) && !ENV_EXAMPLES.contains(&n.as_str()) {
        return true;
    }
    PRIVATE_EXTENSIONS.iter().any(|ext| n.ends_with(ext))
}

/// A path relative to a repository as its segments, or why it could leave it: absolute,
/// a drive letter, home, `..`, `:` (Windows streams) or control characters. Backslashes
/// are separators everywhere. The same rules as `repoPathParts` in contracts/codeTools.ts.
fn rel_parts(rel: &str) -> Result<Vec<String>, String> {
    let p = rel.trim().replace('\\', "/");
    let bytes = p.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let leaves = || Err(trf("code.leaves", &[("path", rel)]));
    if p.starts_with('/') || drive {
        return leaves();
    }
    let parts: Vec<String> = p.split('/').filter(|s| !s.is_empty() && *s != ".").map(str::to_string).collect();
    if parts.first().is_some_and(|s| s == "~") || parts.iter().any(|s| s == ".." || s.contains(':') || s.chars().any(char::is_control)) {
        return leaves();
    }
    Ok(parts)
}

/// The real path of `rel` inside `root` (itself real): it must exist and, links
/// followed, still be inside the root.
fn confine(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = rel_parts(rel)?;
    if parts.iter().any(|p| is_private(p)) {
        return Err(trf("code.private", &[("path", rel)]));
    }
    let joined = parts.iter().fold(root.to_path_buf(), |p, s| p.join(s));
    let real = plain(std::fs::canonicalize(&joined).map_err(|_| trf("code.not_found", &[("path", rel)]))?);
    if !real.starts_with(root) {
        return Err(trf("code.leaves", &[("path", rel)]));
    }
    // A link inside the repository may still lead to one of its private files.
    if real.strip_prefix(root).is_ok_and(|r| r.components().any(|c| is_private(&c.as_os_str().to_string_lossy()))) {
        return Err(trf("code.private", &[("path", rel)]));
    }
    Ok(real)
}

/// `path` under `root` with `/` separators (what the model reads and writes back).
fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Globs and text

/// A glob as a regex: `*` and `?` within a segment, `**` across, `{a,b}`; without a
/// slash it matches the file name anywhere (globMatch in contracts/codeTools.ts).
fn glob_regex(glob: &str) -> Option<regex::Regex> {
    let mut re = String::from("^");
    let chars: Vec<char> = glob.chars().collect();
    let mut depth = 0;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '*' if chars.get(i + 1) == Some(&'*') => {
                if chars.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 2;
                } else {
                    re.push_str(".*");
                    i += 1;
                }
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '{' => {
                depth += 1;
                re.push_str("(?:");
            }
            '}' if depth > 0 => {
                depth -= 1;
                re.push(')');
            }
            ',' if depth > 0 => re.push('|'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    re.push('$');
    regex::RegexBuilder::new(&re).case_insensitive(true).build().ok()
}

fn glob_target<'a>(glob: &str, path: &'a str) -> &'a str {
    if glob.contains('/') {
        path
    } else {
        path.rsplit('/').next().unwrap_or(path)
    }
}

/// A file's text, or None when it is too big or not text (a NUL in its first 8 KB).
fn text_of(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > FILE_BYTES_MAX {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Lines, LF or CRLF, without the empty one after a last newline.
fn lines_of(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.len() > 1 && lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

fn clip(line: &str) -> String {
    match line.char_indices().nth(LINE_CHARS) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

/// Every file under `start` (skipped folders left out, links never followed), depth first
/// in name order, files before subfolders; at most WALK_FILES_MAX, for WALK_TIME at most.
fn walk(start: &Path, mut visit: impl FnMut(&Path) -> bool) -> bool {
    let began = Instant::now();
    let mut stack = vec![start.to_path_buf()];
    let mut files = 0;
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<(String, bool, PathBuf)> = read
            .filter_map(Result::ok)
            .filter_map(|e| {
                let kind = e.file_type().ok()?;
                let name = e.file_name().to_string_lossy().into_owned();
                (!kind.is_symlink() && !is_private(&name)).then(|| (name, kind.is_dir(), e.path()))
            })
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, _, path) in entries.iter().filter(|e| !e.1) {
            files += 1;
            if files > WALK_FILES_MAX || began.elapsed() > WALK_TIME || !visit(path) {
                return false;
            }
        }
        // Reversed onto the stack: the first folder is walked first.
        for (name, _, path) in entries.iter().rev().filter(|e| e.1) {
            if !SKIPPED_DIRS.contains(&name.as_str()) {
                stack.push(path.clone());
            }
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Results (the shapes of contracts/codeTools.ts)

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    name: String,
    dir: bool,
}
#[derive(Serialize, Debug)]
pub struct LsResult {
    path: String,
    entries: Vec<Entry>,
    truncated: bool,
}
#[derive(Serialize, Debug)]
pub struct FindResult {
    paths: Vec<String>,
    truncated: bool,
}
#[derive(Serialize, Debug, PartialEq)]
pub struct Hit {
    path: String,
    line: usize,
    text: String,
}
#[derive(Serialize, Debug)]
pub struct GrepResult {
    hits: Vec<Hit>,
    truncated: bool,
    files: usize,
}
#[derive(Serialize, Debug)]
pub struct ReadResult {
    path: String,
    from: usize,
    to: usize,
    total: usize,
    lines: Vec<String>,
}
#[derive(Serialize, Debug, PartialEq)]
pub struct Changed {
    status: String,
    path: String,
}
#[derive(Serialize, Debug, PartialEq)]
pub struct Commit {
    hash: String,
    date: String,
    subject: String,
    files: Vec<Changed>,
}
#[derive(Serialize, Debug)]
pub struct GitLogResult {
    commits: Vec<Commit>,
}
#[derive(Serialize, Debug)]
pub struct GitShowResult {
    text: String,
    truncated: bool,
}

fn ls(root: &Path, path: &str) -> Result<LsResult, String> {
    let dir = confine(root, path)?;
    if !dir.is_dir() {
        return Err(trf("code.not_a_folder", &[("path", path)]));
    }
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(fault)?
        .filter_map(Result::ok)
        .map(|e| Entry { name: e.file_name().to_string_lossy().into_owned(), dir: e.file_type().is_ok_and(|k| k.is_dir()) })
        .filter(|e| !is_private(&e.name))
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    let truncated = entries.len() > LS_ENTRIES;
    entries.truncate(LS_ENTRIES);
    Ok(LsResult { path: rel_of(root, &dir), entries, truncated })
}

fn find(root: &Path, pattern: &str, path: &str) -> Result<FindResult, String> {
    let start = confine(root, path)?;
    let re = glob_regex(pattern).ok_or_else(|| trf("code.bad_pattern", &[("pattern", pattern)]))?;
    let mut paths = Vec::new();
    let mut truncated = false;
    walk(&start, |file| {
        let rel = rel_of(root, file);
        if re.is_match(glob_target(pattern, &rel)) {
            if paths.len() == FIND_PATHS {
                truncated = true;
                return false;
            }
            paths.push(rel);
        }
        true
    });
    Ok(FindResult { paths, truncated })
}

fn grep(root: &Path, query: &str, regex: bool, glob: Option<&str>) -> Result<GrepResult, String> {
    let pattern = if regex { query.to_string() } else { regex::escape(query) };
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .build()
        .map_err(|_| trf("code.bad_pattern", &[("pattern", query)]))?;
    let only = match glob.filter(|g| !g.trim().is_empty()) {
        Some(g) => Some((g, glob_regex(g).ok_or_else(|| trf("code.bad_pattern", &[("pattern", g)]))?)),
        None => None,
    };
    let mut hits = Vec::new();
    let mut files = 0;
    let mut truncated = false;
    walk(root, |file| {
        let rel = rel_of(root, file);
        if let Some((g, re)) = &only {
            if !re.is_match(glob_target(g, &rel)) {
                return true;
            }
        }
        let Some(text) = text_of(file) else { return true };
        files += 1;
        for (i, line) in lines_of(&text).iter().enumerate() {
            if re.is_match(line) {
                if hits.len() == GREP_HITS {
                    truncated = true;
                    return false;
                }
                hits.push(Hit { path: rel.clone(), line: i + 1, text: clip(line) });
            }
        }
        true
    });
    Ok(GrepResult { hits, truncated, files })
}

fn read(root: &Path, path: &str, from: Option<usize>, to: Option<usize>) -> Result<ReadResult, String> {
    let file = confine(root, path)?;
    if !file.is_file() {
        return Err(trf("code.not_a_file", &[("path", path)]));
    }
    let text = text_of(&file).ok_or_else(|| trf("code.not_text", &[("path", path)]))?;
    let lines = lines_of(&text);
    let from = from.unwrap_or(1).max(1);
    if from > lines.len() {
        return Err(trf("code.past_end", &[("path", path), ("count", &lines.len().to_string())]));
    }
    let last = from + READ_LINES - 1;
    let to = to.unwrap_or(last).min(last).min(lines.len()).max(from);
    Ok(ReadResult { path: rel_of(root, &file), from, to, total: lines.len(), lines: lines[from - 1..to].iter().map(|l| clip(l)).collect() })
}

// ---------------------------------------------------------------------------
// Git

/// A commit id: hex only, 4 to 40 digits (never an option, a range or a ref name).
fn valid_commit(commit: &str) -> bool {
    (4..=40).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The `git` program answers (checked once).
fn git_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| git_command(None).arg("--version").output().is_ok_and(|o| o.status.success()))
}

fn git_command(root: Option<&Path>) -> Command {
    let mut cmd = Command::new("git");
    if let Some(root) = root {
        cmd.arg("-C").arg(root);
    }
    cmd.args(["-c", "core.quotepath=off", "--no-pager"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing for each call.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// The arguments of `git log` for these filters (fixed list, values as single arguments).
fn git_log_args(grep: Option<&str>, path: Option<&str>, limit: u32) -> Result<Vec<String>, String> {
    let mut args: Vec<String> =
        ["log", "--no-color", "--date=short", "--name-status", "--format=%x1e%H%x1f%ad%x1f%s"].iter().map(|s| s.to_string()).collect();
    args.push(format!("--max-count={}", limit.clamp(1, GIT_LOG_MAX)));
    if let Some(g) = grep.map(str::trim).filter(|g| !g.is_empty()) {
        args.extend(["--regexp-ignore-case".into(), "--fixed-strings".into(), format!("--grep={g}")]);
    }
    args.push("--".into());
    if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
        // A literal pathspec: no glob or magic in what the model wrote.
        args.push(format!(":(literal){}", rel_parts(p)?.join("/")));
    }
    Ok(args)
}

fn git_show_args(commit: &str, path: Option<&str>) -> Result<Vec<String>, String> {
    if !valid_commit(commit) {
        return Err(trf("code.bad_commit", &[("commit", commit)]));
    }
    let mut args: Vec<String> =
        ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--format=%H%n%an%n%ad%n%n%B"]
            .iter()
            .map(|s| s.to_string())
            .collect();
    args.push(commit.to_string());
    args.push("--".into());
    if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
        args.push(format!(":(literal){}", rel_parts(p)?.join("/")));
    }
    Ok(args)
}

/// Runs git in `root`; its output up to GIT_OUTPUT_BYTES (and whether there was more),
/// stopped after GIT_TIMEOUT.
fn run_git(root: &Path, args: &[String]) -> Result<(String, bool), String> {
    if !git_available() {
        return Err(tr("code.no_git").into());
    }
    let mut child = git_command(Some(root)).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(fault)?;
    let mut stdout = child.stdout.take().ok_or_else(|| fault("no output"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let read = (&mut stdout).take(GIT_OUTPUT_BYTES as u64 + 1).read_to_end(&mut buf);
        let _ = tx.send(read.map(|_| buf));
    });
    let out = rx.recv_timeout(GIT_TIMEOUT);
    let _ = child.kill();
    let status = child.wait().map_err(fault)?;
    let mut buf = match out {
        Ok(Ok(buf)) => buf,
        _ => return Err(tr("code.git_slow").into()),
    };
    let more = buf.len() > GIT_OUTPUT_BYTES;
    if !more && !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        return Err(trf("code.git_failed", &[("err", err.lines().next().unwrap_or("").trim())]));
    }
    buf.truncate(GIT_OUTPUT_BYTES);
    Ok((String::from_utf8_lossy(&buf).into_owned(), more))
}

fn parse_git_log(out: &str) -> Vec<Commit> {
    out.split('\u{1e}')
        .filter(|c| !c.trim().is_empty())
        .filter_map(|block| {
            let mut lines = block.lines();
            let mut head = lines.next()?.split('\u{1f}');
            let (hash, date, subject) = (head.next()?.to_string(), head.next()?.to_string(), head.next().unwrap_or("").to_string());
            let files = lines
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| {
                    let fields: Vec<&str> = l.split('\t').collect();
                    (fields.len() >= 2)
                        .then(|| Changed { status: fields[0].chars().take(1).collect(), path: fields[fields.len() - 1].to_string() })
                })
                .collect();
            Some(Commit { hash, date, subject, files })
        })
        .collect()
}

fn git_log(root: &Path, grep: Option<&str>, path: Option<&str>, limit: u32) -> Result<GitLogResult, String> {
    let (out, _) = run_git(root, &git_log_args(grep, path, limit)?)?;
    Ok(GitLogResult { commits: parse_git_log(&out) })
}

fn git_show(root: &Path, commit: &str, path: Option<&str>) -> Result<GitShowResult, String> {
    let (out, more) = run_git(root, &git_show_args(commit, path)?)?;
    let cut = out.char_indices().nth(SHOW_CHARS).map(|(at, _)| at);
    Ok(GitShowResult { text: cut.map_or(out.clone(), |at| out[..at].to_string()), truncated: more || cut.is_some() })
}

// ---------------------------------------------------------------------------
// Allowed roots, per server

/// The server a page comes from (scheme, host, port): allowances are its own.
fn origin_of(webview: &Webview) -> Result<String, String> {
    let url = webview.url().map_err(fault)?;
    Ok(url.origin().ascii_serialization())
}

fn allowed_roots(app: &AppHandle, origin: &str) -> Vec<String> {
    let Ok(store) = app.store(STORE) else { return vec![] };
    let all: HashMap<String, Vec<String>> = store.get(KEY).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    all.get(origin).cloned().unwrap_or_default()
}

fn remember_root(app: &AppHandle, origin: &str, root: &Path) -> Result<(), String> {
    let store = app.store(STORE).map_err(fault)?;
    let mut all: HashMap<String, Vec<String>> = store.get(KEY).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let list = all.entry(origin.to_string()).or_default();
    let root = root.to_string_lossy().into_owned();
    if !list.contains(&root) {
        list.push(root);
    }
    store.set(KEY, serde_json::to_value(&all).map_err(fault)?);
    store.save().map_err(fault)
}

/// The real root of a repository this server's page may read, or why not.
fn allowed_root(app: &AppHandle, webview: &Webview, raw: &str) -> Result<PathBuf, String> {
    let root = resolve_root(raw, home_dir().as_deref())?;
    let allowed = allowed_roots(app, &origin_of(webview)?);
    if allowed.iter().any(|a| Path::new(a) == root) {
        Ok(root)
    } else {
        Err(trf("code.not_allowed", &[("path", raw)]))
    }
}

/// Asks the user, in a dialog of the system, whether the chat may read this folder.
/// "Don't allow" is the default button.
#[cfg(target_os = "macos")]
async fn confirm(app: &AppHandle, title: String, message: String) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (allow, deny) = (tr("code.allow").to_string(), tr("code.deny").to_string());
    app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSAlert, NSAlertSecondButtonReturn, NSAlertStyle};
        use objc2_foundation::NSString;
        let answer = MainThreadMarker::new().map(|mtm| {
            let alert = NSAlert::new(mtm);
            alert.setAlertStyle(NSAlertStyle::Warning);
            alert.setMessageText(&NSString::from_str(&title));
            alert.setInformativeText(&NSString::from_str(&message));
            alert.addButtonWithTitle(&NSString::from_str(&deny));
            alert.addButtonWithTitle(&NSString::from_str(&allow));
            alert.runModal() == NSAlertSecondButtonReturn
        });
        let _ = tx.send(answer.unwrap_or(false));
    })
    .map_err(fault)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false)).await.map_err(fault)
}

#[cfg(windows)]
async fn confirm(_app: &AppHandle, title: String, message: String) -> Result<bool, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    tauri::async_runtime::spawn_blocking(move || {
        let (title, message) = (wide(&title), wide(&message));
        // SAFETY: both strings are NUL-terminated UTF-16 that live across the call; no owner window.
        let answer = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND,
            )
        };
        answer == IDYES
    })
    .await
    .map_err(fault)
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn confirm(_app: &AppHandle, _title: String, _message: String) -> Result<bool, String> {
    Err(tr("code.no_dialog").into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    root: String,
    allowed: bool,
    /// Allowed, a git repository, and git installed: the git tools work.
    git: bool,
}

/// Which of these roots this server's page may read. Nothing is looked at on disk for a
/// root that isn't allowed (a page can't probe the folders of this computer).
#[tauri::command]
pub fn code_roots(app: AppHandle, webview: Webview, roots: Vec<String>) -> Result<Vec<RootStatus>, String> {
    let origin = origin_of(&webview)?;
    let allowed = allowed_roots(&app, &origin);
    let home = home_dir();
    Ok(roots
        .into_iter()
        .take(50)
        .map(|raw| {
            let real = allowed.iter().find_map(|a| resolve_root(&raw, home.as_deref()).ok().filter(|r| Path::new(a) == r));
            let git = real.as_ref().is_some_and(|r| r.join(".git").exists() && git_available());
            RootStatus { root: raw, allowed: real.is_some(), git }
        })
        .collect())
}

/// Asks the user to let this server's chat read a repository (a native dialog); kept.
#[tauri::command]
pub async fn code_allow_root(app: AppHandle, webview: Webview, root: String) -> Result<bool, String> {
    let real = resolve_root(&root, home_dir().as_deref())?;
    let origin = origin_of(&webview)?;
    if allowed_roots(&app, &origin).iter().any(|a| Path::new(a) == real) {
        return Ok(true);
    }
    let shown = real.to_string_lossy().into_owned();
    let message = trf("code.allow_message", &[("path", &shown), ("server", &origin)]);
    if !confirm(&app, tr("code.allow_title").to_string(), message).await? {
        return Ok(false);
    }
    remember_root(&app, &origin, &real)?;
    Ok(true)
}

/// Runs a walk or a git call off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(fault)?
}

#[tauri::command]
pub async fn code_ls(app: AppHandle, webview: Webview, root: String, path: String) -> Result<LsResult, String> {
    let root = allowed_root(&app, &webview, &root)?;
    blocking(move || ls(&root, &path)).await
}

#[tauri::command]
pub async fn code_find(app: AppHandle, webview: Webview, root: String, pattern: String, path: String) -> Result<FindResult, String> {
    let root = allowed_root(&app, &webview, &root)?;
    blocking(move || find(&root, &pattern, &path)).await
}

#[tauri::command]
pub async fn code_grep(
    app: AppHandle,
    webview: Webview,
    root: String,
    query: String,
    regex: bool,
    glob: Option<String>,
) -> Result<GrepResult, String> {
    let root = allowed_root(&app, &webview, &root)?;
    blocking(move || grep(&root, &query, regex, glob.as_deref())).await
}

#[tauri::command]
pub async fn code_read(
    app: AppHandle,
    webview: Webview,
    root: String,
    path: String,
    from: Option<usize>,
    to: Option<usize>,
) -> Result<ReadResult, String> {
    let root = allowed_root(&app, &webview, &root)?;
    blocking(move || read(&root, &path, from, to)).await
}

#[tauri::command]
pub async fn code_git_log(
    app: AppHandle,
    webview: Webview,
    root: String,
    grep: Option<String>,
    path: Option<String>,
    limit: u32,
) -> Result<GitLogResult, String> {
    let root = allowed_root(&app, &webview, &root)?;
    blocking(move || git_log(&root, grep.as_deref(), path.as_deref(), limit)).await
}

#[tauri::command]
pub async fn code_git_show(
    app: AppHandle,
    webview: Webview,
    root: String,
    commit: String,
    path: Option<String>,
) -> Result<GitShowResult, String> {
    let root = allowed_root(&app, &webview, &root)?;
    blocking(move || git_show(&root, &commit, path.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system's temp folder, removed at the end.
    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Temp {
            let dir = std::env::temp_dir().join(format!("ikl-code-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Temp(plain(std::fs::canonicalize(&dir).unwrap()))
        }
        fn file(&self, rel: &str, body: &[u8]) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn relative_paths_only() {
        assert_eq!(rel_parts("").unwrap(), Vec::<String>::new());
        assert_eq!(rel_parts("./src//app/").unwrap(), vec!["src", "app"]);
        assert_eq!(rel_parts(r"src\app\Main.kt").unwrap(), vec!["src", "app", "Main.kt"]);
        for bad in [
            "/etc/passwd",
            r"\etc",
            r"C:\Windows",
            "c:/x",
            r"\\server\share",
            "~/x",
            "~",
            "..",
            "../x",
            "src/../../x",
            r"src\..\..",
            "a/./../b",
            "x\u{0}y",
            "f.txt:stream",
        ] {
            assert!(rel_parts(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn confined_to_the_root_links_included() {
        let t = Temp::new("confine");
        t.file("src/a.kt", b"a");
        let outside = Temp::new("outside");
        outside.file("secret.txt", b"secret");
        assert_eq!(confine(&t.0, "src/a.kt").unwrap(), t.0.join("src").join("a.kt"));
        assert!(confine(&t.0, "../outside/secret.txt").is_err());
        assert!(confine(&t.0, outside.0.join("secret.txt").to_str().unwrap()).is_err());
        assert!(confine(&t.0, "src/missing.kt").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside.0, t.0.join("link")).unwrap();
            std::os::unix::fs::symlink(outside.0.join("secret.txt"), t.0.join("src/leak.txt")).unwrap();
            assert!(confine(&t.0, "link/secret.txt").is_err());
            assert!(confine(&t.0, "src/leak.txt").is_err());
            assert!(read(&t.0, "src/leak.txt", None, None).is_err());
            assert!(ls(&t.0, "link").is_err());
            // A walk never follows a link out.
            assert!(grep(&t.0, "secret", false, None).unwrap().hits.is_empty());
            // A link that stays inside is fine.
            std::os::unix::fs::symlink(t.0.join("src/a.kt"), t.0.join("inside.kt")).unwrap();
            assert!(confine(&t.0, "inside.kt").is_ok());
        }
    }

    #[test]
    fn roots_from_home_or_absolute() {
        let t = Temp::new("home");
        std::fs::create_dir_all(t.0.join("code/app")).unwrap();
        assert_eq!(resolve_root("~/code/app", Some(&t.0)).unwrap(), t.0.join("code/app"));
        assert_eq!(resolve_root(t.0.join("code/app").to_str().unwrap(), None).unwrap(), t.0.join("code/app"));
        assert!(resolve_root("code/app", Some(&t.0)).is_err());
        assert!(resolve_root("~/code/missing", Some(&t.0)).is_err());
        assert!(resolve_root("~/code/app", None).is_err());
    }

    #[test]
    fn tools_read_crlf_and_skip_what_isnt_code() {
        let t = Temp::new("tools");
        t.file("README.md", b"# Shop\r\nMAGA-400 notes\r\n");
        t.file("src/Inventory.kt", b"line 1\n// MAGA-400 stock\nline 3\n");
        t.file("src/logo.png", &[0x89, 0x50, 0, 0, b'M', b'A', b'G', b'A', b'-', b'4', b'0', b'0']);
        t.file("node_modules/x/index.js", b"MAGA-400");
        t.file(".git/HEAD", b"MAGA-400");
        let hits = grep(&t.0, "maga-400", false, None).unwrap();
        assert_eq!(
            hits.hits,
            vec![
                Hit { path: "README.md".into(), line: 2, text: "MAGA-400 notes".into() },
                Hit { path: "src/Inventory.kt".into(), line: 2, text: "// MAGA-400 stock".into() }
            ]
        );
        assert_eq!(grep(&t.0, r"stock$", true, Some("*.kt")).unwrap().hits.len(), 1);
        assert!(grep(&t.0, "(", true, None).is_err());
        let r = read(&t.0, "README.md", None, None).unwrap();
        assert_eq!((r.total, r.lines.clone()), (2, vec!["# Shop".to_string(), "MAGA-400 notes".to_string()]));
        assert!(read(&t.0, "src/logo.png", None, None).is_err());
        assert_eq!(read(&t.0, "src/Inventory.kt", Some(2), Some(2)).unwrap().lines, vec!["// MAGA-400 stock"]);
        assert_eq!(find(&t.0, "*inventory*", "").unwrap().paths, vec!["src/Inventory.kt"]);
        assert_eq!(find(&t.0, "src/**/*.kt", "").unwrap().paths, vec!["src/Inventory.kt"]);
        let listed = ls(&t.0, "").unwrap();
        assert!(listed.entries.iter().all(|e| e.name != ".git"), "version control is never listed");
        assert_eq!(listed.entries.last(), Some(&Entry { name: "README.md".into(), dir: false }));
    }

    #[test]
    fn secrets_are_never_shown() {
        for name in [
            ".git",
            ".ssh",
            ".env",
            ".env.local",
            "server.pem",
            "app.key",
            "release.jks",
            "id_rsa",
            "ID_ED25519",
            ".npmrc",
            ".git-credentials",
        ] {
            assert!(is_private(name), "{name}");
        }
        for name in [".env.example", ".env.sample", "id_rsa.pub", "keys.rs", "monkey.kt", ".gitignore", "env.ts"] {
            assert!(!is_private(name), "{name}");
        }
        let t = Temp::new("private");
        t.file(".git/config", b"url = https://token@example.com/shop.git");
        t.file(".env", b"TOKEN=MAGA-400-secret");
        t.file(".env.example", b"TOKEN=");
        t.file("deploy/server.pem", b"PRIVATE KEY MAGA-400");
        t.file("src/a.kt", b"MAGA-400");
        for path in [".git/config", ".git", ".env", "deploy/server.pem", r"deploy\SERVER.PEM"] {
            assert!(read(&t.0, path, None, None).is_err(), "{path}");
        }
        assert!(ls(&t.0, ".git").is_err());
        let names: Vec<String> = ls(&t.0, "").unwrap().entries.into_iter().map(|e| e.name).collect();
        assert!(!names.iter().any(|n| n == ".env" || n == ".git"), "{names:?}");
        assert!(names.iter().any(|n| n == ".env.example"));
        let hits: Vec<String> = grep(&t.0, "MAGA-400|token@", true, None).unwrap().hits.into_iter().map(|h| h.path).collect();
        assert_eq!(hits, vec!["src/a.kt"]);
        assert!(find(&t.0, "*", "").unwrap().paths.iter().all(|p| !p.ends_with(".env") && !p.ends_with(".pem")));
        assert!(read(&t.0, ".env.example", None, None).is_ok());
    }

    #[test]
    fn a_root_is_a_project_not_a_disk_or_home() {
        let home = Temp::new("home");
        std::fs::create_dir_all(home.0.join("projects/shop")).unwrap();
        assert!(resolve_root("~", Some(&home.0)).is_err());
        assert!(resolve_root(home.0.to_str().unwrap(), Some(&home.0)).is_err());
        assert!(resolve_root("/", Some(&home.0)).is_err());
        assert!(resolve_root("~/projects/shop", Some(&home.0)).is_ok());
    }

    #[test]
    fn git_arguments_are_fixed_and_checked() {
        for ok in ["1a2b", "1A2B3C4D", "0123456789abcdef0123456789abcdef01234567"] {
            assert!(valid_commit(ok), "{ok}");
        }
        for bad in [
            "",
            "abc",
            "HEAD",
            "HEAD~1",
            "--output=/tmp/x",
            "1a2b;rm",
            "1a2b 3c",
            "main",
            "a..b",
            "0123456789abcdef0123456789abcdef012345678",
        ] {
            assert!(valid_commit(bad) == false, "{bad}");
            assert!(git_show_args(bad, None).is_err(), "{bad}");
        }
        let log = git_log_args(Some("--output=/tmp/x"), Some("src/a b.kt"), 500).unwrap();
        // A value is never an option of its own; the path is literal, after `--`.
        assert!(log.contains(&"--grep=--output=/tmp/x".to_string()));
        assert!(log.contains(&"--max-count=30".to_string()));
        assert_eq!(&log[log.len() - 2..], &["--".to_string(), ":(literal)src/a b.kt".to_string()]);
        assert!(git_log_args(None, Some("../x"), 5).is_err());
        assert!(git_log_args(None, Some("/etc"), 5).is_err());
        let show = git_show_args("abc1234", Some(r"src\a.kt")).unwrap();
        assert!(show.contains(&"--no-ext-diff".to_string()) && show.contains(&"--no-textconv".to_string()));
        assert_eq!(&show[show.len() - 3..], &["abc1234".to_string(), "--".to_string(), ":(literal)src/a.kt".to_string()]);
    }

    #[test]
    fn reads_git_log_output() {
        let out = "\u{1e}abc123\u{1f}2026-10-01\u{1f}MAGA-400 fix stock\n\nM\tsrc/Stock.kt\nR100\told.kt\tnew.kt\n\u{1e}def456\u{1f}2026-09-30\u{1f}Other\n";
        let commits = parse_git_log(out);
        assert_eq!(commits.len(), 2);
        assert_eq!(
            commits[0].files,
            vec![Changed { status: "M".into(), path: "src/Stock.kt".into() }, Changed { status: "R".into(), path: "new.kt".into() }]
        );
        assert_eq!(commits[1].subject, "Other");
    }

    #[test]
    fn git_in_a_real_repository_when_git_is_here() {
        if !git_available() {
            return;
        }
        let t = Temp::new("git");
        let git = |args: &[&str]| git_command(Some(&t.0)).args(args).output().unwrap();
        git(&["init", "-q"]);
        t.file("src/Stock.kt", b"val stock = 0\n");
        git(&["add", "."]);
        git(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "MAGA-400 stock never below zero"]);
        let log = git_log(&t.0, Some("maga-400"), None, 5).unwrap();
        assert_eq!(log.commits.len(), 1);
        assert_eq!(log.commits[0].files, vec![Changed { status: "A".into(), path: "src/Stock.kt".into() }]);
        let hash = &log.commits[0].hash[..10];
        let show = git_show(&t.0, hash, None).unwrap();
        assert!(show.text.contains("val stock = 0"), "{}", show.text);
        assert!(git_log(&t.0, Some("MAGA-999"), None, 5).unwrap().commits.is_empty());
    }

    #[test]
    fn globs() {
        let m = |g: &str, p: &str| glob_regex(g).is_some_and(|re| re.is_match(glob_target(g, p)));
        assert!(m("*.kt", "src/app/Main.kt"));
        assert!(!m("*.kt", "src/app/Main.java"));
        assert!(m("src/**/*.ts", "src/c.ts"));
        assert!(!m("src/*.ts", "src/a/c.ts"));
        assert!(m("{src,lib}/*.ts", "lib/c.ts"));
        assert!(m("a+b.(x)", "a+b.(x)"));
        assert!(!m("a+b.(x)", "aab.(x)"));
    }
}
