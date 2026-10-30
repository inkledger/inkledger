// An issue as an agent gets it (docs/work/ideas/issue-copy.md): header,
// description, attachments as signed links through this app. Shared by
// issues.copyForAgent and the triage prompt (ideas.handoff).
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { issues, type User } from "@db/schema";
import { t } from "@contracts/i18n";
import { issueMarkdown } from "@contracts/issueCopy";
import { getDb } from "../queries/connection";
import { boundTracker } from "../sync/engine";
import { contextFor, issueConnection } from "../providers/connections";
import { providerCall } from "../providers/trpc";
import { toRichDoc } from "../providers/core/richtext";
import { fetchAttachments } from "../jira/client";
import { signShare } from "../lib/shareLinks";
import { getSettings } from "../routers/settings";
import { callMeta } from "./search";

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
    .where(and(eq(issues.userId, user.id), eq(issues.connectionId, conn.id), eq(issues.key, key)))
    .limit(1);
  if (!b || !row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
  const prefs = await getSettings(user.id);
  const now = Date.now();
  const exp = now + (o.minutes ?? prefs.shareLinkMinutes) * 60_000;
  const ref = { remoteId: row.remoteId ?? key, key };
  const body = b.description ? await providerCall(() => b.description!(callMeta(), ref)) : null;
  // Attachments are Jira's alone for now (GitHub follows: batch C4).
  const files = conn.type === "jira" ? await fetchAttachments(contextFor(user, conn).creds, key) : [];
  const attachments = files.map((f) => ({
    name: f.filename,
    url: `${o.origin}/api/shared/${signShare({ u: user.id, c: conn.id, a: f.id, iat: now, exp, g: prefs.shareLinkGeneration })}`,
  }));
  const markdown = issueMarkdown(
    { key, title: row.summary, url: row.url, status: row.status, type: row.issueType || null },
    toRichDoc(body),
    attachments,
    o.depth,
  );
  return { markdown, expiresAt: new Date(exp) };
}
