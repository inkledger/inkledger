// An issue as an agent gets it (docs/work/ideas/issue-copy.md): header,
// description, comments, attachments as signed links through this app. Shared by
// issues.copyForAgent and the triage prompt (ideas.handoff).
import { TRPCError } from "@trpc/server";
import { issues, type User } from "@db/schema";
import { t } from "@contracts/i18n";
import { issueMarkdown, type IssueCopyComments } from "@contracts/issueCopy";
import { mapUrls, type RichDoc } from "@contracts/richtext";
import { bodyAttachments } from "../providers/github/attachments";
import { getDb } from "../queries/connection";
import { issueAt } from "../queries/issueAt";
import { boundTracker } from "../sync/engine";
import { contextFor, issueConnection } from "../providers/connections";
import { providerCall } from "../providers/trpc";
import { toRichDoc } from "../providers/core/richtext";
import { fetchAttachments } from "../jira/client";
import { signShare } from "../lib/shareLinks";
import { getSettings } from "../routers/settings";
import { callMeta } from "../lib/callMeta";

export type AgentCopy = { markdown: string; expiresAt: Date };

/**
 * The issue's Markdown with links valid `minutes` (the user's default when
 * absent), absolute on `origin`. NOT_FOUND when the issue isn't the user's.
 */
export async function agentCopy(
  user: User,
  key: string,
  o: { connectionId?: number; minutes?: number; origin: string; depth?: number },
): Promise<AgentCopy> {
  const conn = await issueConnection(user.id, key, o.connectionId);
  const b = boundTracker(conn);
  const [row] = await getDb()
    .select({ remoteId: issues.remoteId, summary: issues.summary, status: issues.status, issueType: issues.issueType, url: issues.url })
    .from(issues)
    .where(issueAt(user.id, conn.id, key))
    .limit(1);
  if (!b || !row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
  const prefs = await getSettings(user.id);
  const now = Date.now();
  const exp = now + (o.minutes ?? prefs.shareLinkMinutes) * 60_000;
  const ref = { remoteId: row.remoteId ?? key, key };
  const body = b.description ? await providerCall(() => b.description!(callMeta(), ref)) : null;
  const link = (a: string, k?: string, m?: string) =>
    `${o.origin}/api/shared/${signShare({ u: user.id, c: conn.id, a, iat: now, exp, g: prefs.shareLinkGeneration, ...(k ? { k } : {}), ...(m ? { m } : {}) })}`;
  // Extra context: a tracker that can't list them now still lets the issue be copied (R-6.10).
  const remoteComments = b.comments
    ? await providerCall(() => b.comments!.list(callMeta(), ref)).catch(() => null)
    : [];
  const chronological = [...(remoteComments ?? [])].sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
  let doc = toRichDoc(body);
  let commentDocs: RichDoc[] = chronological.map((c) => toRichDoc(c.body));
  let attachments: { name: string; url: string }[] = [];
  if (conn.type === "jira") {
    // Files in comments are the issue's attachments too, named the same way.
    attachments = (await fetchAttachments(contextFor(user, conn).creds, key)).map((f) => ({ name: f.filename, url: link(f.id) }));
  } else if (conn.type === "github") {
    // Pasted into the body or a comment: found by their github.com link, served through it (R-6.9).
    const shared = (text: string, commentId?: string) => {
      const pasted = bodyAttachments(text).map((p) => ({ ...p, shared: link(p.url, key, commentId) }));
      attachments.push(...pasted.map((p) => ({ name: p.name, url: p.shared })));
      const byUrl = new Map(pasted.map((p) => [p.url, p.shared]));
      return (d: RichDoc) => mapUrls(d, (url) => byUrl.get(url) ?? null);
    };
    if (body?.kind === "text") doc = shared(body.text)(doc);
    commentDocs = chronological.map((c, i) => (c.body.kind === "text" ? shared(c.body.text, c.id)(commentDocs[i]) : commentDocs[i]));
  }
  const comments: IssueCopyComments = remoteComments
    ? chronological.map((c, i) => ({ author: c.author.name || "—", created: c.createdAt, doc: commentDocs[i] }))
    : "unavailable";
  const markdown = issueMarkdown({ key, title: row.summary, url: row.url, status: row.status, type: row.issueType || null }, doc, attachments, o.depth, comments);
  return { markdown, expiresAt: new Date(exp) };
}
