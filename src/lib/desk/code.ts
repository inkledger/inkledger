import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DESK_CHAT_REACH_PATH, type DeskChatReach, type DeskChatToolCall } from "@contracts/deskChat";
import { deskIssues, paneId, type DeskSlot } from "@contracts/desk";
import { CODE_TOOLS, FILE_TOOLS, formatToolResult, parseToolArgs, type CodeToolName, type ToolResults } from "@contracts/codeTools";
import { getLocale, t } from "@/i18n";
import { codeAllowRoot, codeFind, codeGitLog, codeGitShow, codeGrep, codeLs, codeRead, codeRoots, isNative, nativeInfo } from "@/lib/native";
import { browserTool } from "./browserCode";
import { canConnectFolders, connectFolder, forgetFolder, readable, useFolders, type Folder } from "./folders";
import type { ToolRun } from "./agent";

/**
 * The code the Desk chat can reach (docs/work/desk.md, batch 4d), and the tool executors:
 * in the app (macOS, Windows) the repositories attached to the issues' projects, each once
 * allowed in a native dialog; in a browser with the File System Access API the folders the
 * user connected; elsewhere none. The agent loop (agent.ts) is the same for all.
 */

type Project = DeskChatReach["projects"][number];

/** A repository the tools can read now, by its label (what the model names). */
export type Repo = { label: string; projectKey: string; git: boolean; source: { kind: "native"; root: string } | { kind: "browser"; folder: Folder } };

/** A repository as the panel shows it: ready, or what it needs first. */
export type RepoView =
  | { kind: "native"; label: string; projectKey: string; root: string; state: "ready" | "allow" }
  | { kind: "browser"; label: string; projectKey: string; folder: Folder; state: "ready" | "permission" };

export type CodeReach = {
  /** Where the tools run: the app, a browser that can connect folders, or nowhere here. */
  where: "native" | "browser" | "none";
  loading: boolean;
  model: DeskChatReach["model"] | null;
  projects: Project[];
  issues: DeskChatReach["issues"];
  views: RepoView[];
  repos: Repo[];
  tools: CodeToolName[];
  /** The model explores with tools; the page searches for it (no tool support); no code. */
  mode: "tools" | "extracts" | "none";
  allow: (root: string) => Promise<void>;
  connect: (containerId: number) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  /** Asks the browser again for a folder's permission (needs the click). */
  permit: (folder: Folder) => Promise<void>;
};

const lastSegment = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
const cleanLabel = (s: string) => s.replace(/[\\/]+/g, "-").replace(/^~+/, "").trim().slice(0, 60) || "repo";

/** Labels the model can tell apart: the one set in Settings (or the folder's name), then the project's key, then a number. */
export function uniqueLabels(items: readonly { label: string; projectKey: string }[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    let label = cleanLabel(item.label);
    if (items.filter(i => cleanLabel(i.label) === label).length > 1) label = `${label}-${item.projectKey.toLowerCase()}`;
    let candidate = label;
    for (let n = 2; out.includes(candidate); n++) candidate = `${label}-${n}`;
    out.push(candidate);
  }
  return out;
}

async function fetchReach(panes: readonly DeskSlot[]): Promise<DeskChatReach> {
  const res = await fetch(DESK_CHAT_REACH_PATH, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-locale": getLocale() },
    body: JSON.stringify({ panes }),
  });
  if (!res.ok) throw new Error(String(res.status));
  // The server's own answer (contracts/deskChat.ts).
  return (await res.json()) as DeskChatReach;
}

/** What the chat can reach for the issues on the desk, and the actions that bring more in. */
export function useCodeReach(panes: readonly DeskSlot[]): CodeReach {
  const shown = deskIssues({ panes }).map(paneId);
  const shownKey = shown.join(",");
  const reach = useQuery({ queryKey: ["desk-chat-reach", shown], queryFn: () => fetchReach(panes), staleTime: 60_000, enabled: shown.length > 0 });
  const native = useQuery({ queryKey: ["native-info"], queryFn: async () => (await nativeInfo()) ?? null, enabled: isNative(), staleTime: Infinity });
  const where: CodeReach["where"] = isNative() ? (native.data && ["macos", "windows"].includes(native.data.platform) ? "native" : "none") : canConnectFolders() ? "browser" : "none";
  const projects = reach.data?.projects ?? [];
  const roots = where === "native" ? projects.flatMap(p => p.repos.map(r => r.path)) : [];
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["code-roots", roots], queryFn: async () => (await codeRoots(roots)) ?? [], enabled: roots.length > 0 });
  const folders = useFolders();
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const folderIds = folders.map(f => f.id).join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(folders.map(async f => [f.id, await readable(f, false)] as const)).then(list => live && setGranted(Object.fromEntries(list)));
    return () => {
      live = false;
    };
    // The folders' ids say when to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderIds]);

  return useMemo(() => {
    const found: RepoView[] = [];
    const git: boolean[] = [];
    if (where === "native")
      for (const p of projects)
        for (const r of p.repos) {
          const s = status.data?.find(x => x.root === r.path);
          found.push({ kind: "native", label: r.label || lastSegment(r.path), projectKey: p.key, root: r.path, state: s?.allowed ? "ready" : "allow" });
          git.push(s?.git ?? false);
        }
    if (where === "browser")
      for (const p of projects)
        for (const f of folders.filter(x => x.containerId === p.containerId)) {
          found.push({ kind: "browser", label: f.name, projectKey: p.key, folder: f, state: granted[f.id] === false ? "permission" : "ready" });
          git.push(false);
        }
    const labels = uniqueLabels(found);
    const views: RepoView[] = found.map((v, i) => ({ ...v, label: labels[i] }));
    const repos: Repo[] = views.flatMap((v, i) =>
      v.state !== "ready" ? [] : [{ label: v.label, projectKey: v.projectKey, git: git[i], source: v.kind === "native" ? { kind: "native" as const, root: v.root } : { kind: "browser" as const, folder: v.folder } }],
    );
    const tools: CodeToolName[] = !repos.length ? [] : where === "native" ? CODE_TOOLS.filter(n => repos.some(r => r.git) || !n.startsWith("git_")) : [...FILE_TOOLS];
    const model = reach.data?.model ?? null;
    const mode: CodeReach["mode"] = !tools.length || !model?.on ? "none" : model.tools ? "tools" : "extracts";
    return {
      where,
      loading: (reach.isPending && shown.length > 0) || (isNative() && native.isPending),
      model,
      projects,
      issues: reach.data?.issues ?? [],
      views,
      repos,
      tools,
      mode,
      allow: async (root: string) => {
        await codeAllowRoot(root);
        await queryClient.invalidateQueries({ queryKey: ["code-roots"] });
      },
      connect: async (containerId: number) => {
        await connectFolder(containerId);
      },
      disconnect: forgetFolder,
      permit: async (folder: Folder) => {
        const ok = await readable(folder, true);
        setGranted(g => ({ ...g, [folder.id]: ok }));
      },
    };
    // Rebuilt when what it reads changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where, reach.data, reach.isPending, native.isPending, status.data, folders, granted, shownKey]);
}

const shortPath = (path: string) => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `${parts[0]}/…/${parts[parts.length - 1]}` : parts.join("/") || ".";
};
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** What a step does, in a few words ("Searching “inventario” in app"). */
export function describeCall(call: DeskChatToolCall): string {
  const a = call.arguments;
  const repo = str(a.repo);
  switch (call.name) {
    case "ls":
      return t("pages.deskChat.step.ls", { path: shortPath(str(a.path)), repo });
    case "find":
      return t("pages.deskChat.step.find", { pattern: str(a.pattern), repo });
    case "grep":
      return t("pages.deskChat.step.grep", { query: str(a.query), repo });
    case "read":
      return t("pages.deskChat.step.read", { path: shortPath(str(a.path)) });
    case "git_log":
      return a.grep ? t("pages.deskChat.step.gitLogGrep", { grep: str(a.grep) }) : a.path ? t("pages.deskChat.step.gitLogPath", { path: shortPath(str(a.path)) }) : t("pages.deskChat.step.gitLog", { repo });
    case "git_show":
      return t("pages.deskChat.step.gitShow", { commit: str(a.commit).slice(0, 10) });
  }
}

/** How much a result holds, in words ("3 hits"); "" when there is nothing to count. */
function countOf(name: CodeToolName, r: ToolResults[CodeToolName]): { text: string; empty: boolean } {
  if (name === "grep" && "hits" in r) return { text: t("pages.deskChat.step.hits", { count: r.hits.length }), empty: !r.hits.length };
  if (name === "find" && "paths" in r) return { text: t("pages.deskChat.step.files", { count: r.paths.length }), empty: !r.paths.length };
  if (name === "ls" && "entries" in r) return { text: t("pages.deskChat.step.entries", { count: r.entries.length }), empty: !r.entries.length };
  if (name === "git_log" && "commits" in r) return { text: t("pages.deskChat.step.commits", { count: r.commits.length }), empty: !r.commits.length };
  if (name === "read" && "lines" in r) return { text: t("pages.deskChat.step.lines", { from: r.from, to: r.to, total: r.total }), empty: false };
  return { text: "", empty: false };
}

/** A tool through the app's Rust commands (src-tauri/src/code.rs); they refuse what isn't allowed. */
async function nativeTool(root: string, call: DeskChatToolCall): Promise<ToolResults[CodeToolName] | undefined> {
  switch (call.name) {
    case "ls": {
      const p = parseToolArgs("ls", call.arguments);
      return p.ok ? codeLs(root, p.args.path) : undefined;
    }
    case "find": {
      const p = parseToolArgs("find", call.arguments);
      return p.ok ? codeFind(root, p.args.pattern, p.args.path) : undefined;
    }
    case "grep": {
      const p = parseToolArgs("grep", call.arguments);
      return p.ok ? codeGrep(root, p.args.query, p.args.regex ?? false, p.args.glob || null) : undefined;
    }
    case "read": {
      const p = parseToolArgs("read", call.arguments);
      return p.ok ? codeRead(root, p.args.path, p.args.from ?? null, p.args.to ?? null) : undefined;
    }
    case "git_log": {
      const p = parseToolArgs("git_log", call.arguments);
      return p.ok ? codeGitLog(root, p.args.grep || null, p.args.path || null, p.args.limit) : undefined;
    }
    case "git_show": {
      const p = parseToolArgs("git_show", call.arguments);
      return p.ok ? codeGitShow(root, p.args.commit, p.args.path || null) : undefined;
    }
  }
}

const failed = (call: DeskChatToolCall, why: string): ToolRun => ({ ok: false, text: `error: ${why}`, brief: `${describeCall(call)}: ${why}` });

/** Runs a tool the model asked for on the repositories in reach. */
export async function runCodeTool(call: DeskChatToolCall, repos: readonly Repo[], signal?: AbortSignal): Promise<ToolRun> {
  const parsed = parseToolArgs(call.name, call.arguments);
  if (!parsed.ok) return failed(call, parsed.error);
  const named = parsed.args.repo;
  const repo =
    typeof named === "number"
      ? repos[named]
      : (repos.find(r => r.label.toLowerCase() === named.toLowerCase()) ?? (/^\d+$/.test(named) ? repos[Number(named)] : undefined));
  if (!repo) return failed(call, `no repository "${named}": use one of ${repos.map((r, i) => `${i} = ${r.label}`).join(", ")}`);
  let result: ToolResults[CodeToolName] | undefined;
  try {
    if (repo.source.kind === "browser") {
      if (!(await readable(repo.source.folder, false))) return failed(call, t("pages.deskChat.code.needsPermission"));
      const out = await browserTool(repo.source.folder.handle, call.name, call.arguments, signal);
      if (!out.ok) return failed(call, out.error);
      result = out.result;
    } else {
      if (call.name.startsWith("git_") && !repo.git) return failed(call, `git isn't available for ${repo.label}`);
      result = await nativeTool(repo.source.root, call);
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    return failed(call, typeof e === "string" ? e : e instanceof Error ? e.message : t("pages.deskChat.failed"));
  }
  if (!result) return failed(call, t("pages.deskChat.failed"));
  const count = countOf(call.name, result);
  return { ok: true, text: formatToolResult(call.name, result), brief: count.text ? `${describeCall(call)}: ${count.text}` : describeCall(call), empty: count.empty };
}
