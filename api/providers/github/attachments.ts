// Files and images pasted into a GitHub issue, fetched for a link shared with
// an agent (docs/work/ideas/issue-copy.md R-6.9). A private repository serves
// them only to a browser session, so they are found again in the issue's
// rendered body (body_html), whose links are signed for a few minutes:
// asked fresh on every download, the connection's token never leaves the server.
import { safeFetch } from "../core/http";
import { ProviderError } from "../core/errors";
import type { GitHubCreds } from "./client";
import { issuePath } from "./adapter";

/** github.com pastes (assets, files) and the older image hosts. */
const PASTED = /https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/|(?:private-)?user-images\.githubusercontent\.com\/)[^\s)"'<>\]]+/g;
/** Where a pasted file's bytes may come from. */
const FILE_HOSTS = new Set(["github.com", "private-user-images.githubusercontent.com", "user-images.githubusercontent.com", "objects.githubusercontent.com"]);

export type GitHubPasted = { url: string; name: string };

/** The id GitHub gives a paste: its UUID or numbered path, the same in body and body_html. */
const assetId = (url: string): string => {
  const path = new URL(url).pathname;
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(path)?.[1] ?? /\/files\/(\d+)\//.exec(path)?.[1] ?? path;
};

/** The files and images pasted into a body (Markdown or HTML), each once. */
export function bodyAttachments(body: string): GitHubPasted[] {
  const seen = new Map<string, GitHubPasted>();
  for (const url of body.match(PASTED) ?? []) {
    if (seen.has(url)) continue;
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const named = /\/files\//.test(url) && last ? last : `image-${assetId(url).slice(0, 8)}`;
    seen.set(url, { url, name: named });
  }
  return [...seen.values()];
}

const fail = (status: number, message: string) => new ProviderError(status === 404 ? "notFound" : "invalid", message);

/** A pasted file's bytes, by its github.com link in the issue `key`. */
export async function fetchGitHubAttachment(c: GitHubCreds, key: string, url: string): Promise<Response> {
  const res = await safeFetch({
    site: c.apiBase,
    url: `${c.apiBase.replace(/\/+$/, "")}${issuePath(key)}`,
    init: { headers: { Accept: "application/vnd.github.full+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${c.token}` } },
    fail,
  });
  if (!res.ok) throw fail(res.status, `GitHub: issue ${key} not readable (${res.status})`);
  const issue = (await res.json()) as { body?: string | null; body_html?: string | null };
  // Still in the issue: a link copied before an edit removed it opens nothing.
  if (!(issue.body ?? "").includes(url)) throw fail(404, "GitHub: no longer in the issue");
  const id = assetId(url);
  const html = (issue.body_html ?? "").replace(/&amp;/g, "&");
  const signed = (html.match(/https:\/\/[^\s"'<>]+/g) ?? []).find((u) => u !== url && FILE_HOSTS.has(new URL(u).hostname) && u.includes(id));
  const target = signed ?? url;
  if (!FILE_HOSTS.has(new URL(target).hostname)) throw fail(400, "GitHub: not a GitHub file host");
  // No token: the signed link is the credential; a public repository's link needs none.
  const file = await safeFetch({ site: target, url: target, init: {}, allowCrossOrigin: true, fail });
  if (!file.ok) throw fail(file.status, `GitHub: file not served (${file.status})`);
  return file;
}
