import { ideaFileUrl, replaceIdeaFiles } from "@contracts/ideaFiles";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * An idea's text made ready for its new issue: each of its pictures fetched and
 * named `idea-<id>.<ext>` (unique: pasted screenshots are all "image.png"), the
 * text pointing at those names, as the tracker's attachments will be called.
 */
export async function ideaImagesForIssue(markdown: string): Promise<{ markdown: string; files: File[] }> {
  const files = new Map<number, File>();
  for (const m of markdown.matchAll(/idea-file:(\d+)/g)) {
    const id = Number(m[1]);
    if (files.has(id)) continue;
    const res = await fetch(ideaFileUrl(id), { credentials: "same-origin" }).catch(() => null);
    if (!res?.ok) continue;
    const blob = await res.blob();
    const ext = EXT[blob.type] ?? "png";
    files.set(id, new File([blob], `idea-${id}.${ext}`, { type: blob.type }));
  }
  return { markdown: replaceIdeaFiles(markdown, id => files.get(id)?.name ?? null), files: [...files.values()] };
}

/** The pictures attached to the issue just made; false when the tracker refused them. */
export async function attachToIssue(issueKey: string, connectionId: number | undefined, files: File[]): Promise<boolean> {
  if (!files.length) return true;
  const form = new FormData();
  for (const f of files) form.append("file", f);
  const at = `/api/issues/${encodeURIComponent(issueKey)}/attachments${connectionId ? `?c=${connectionId}` : ""}`;
  const res = await fetch(at, { method: "POST", body: form, credentials: "same-origin" }).catch(() => null);
  return !!res?.ok;
}
