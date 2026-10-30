// An issue as an agent gets it, pasted by hand (docs/work/ideas/issue-copy.md R-6.1):
// a header, the description, every attachment as a link through this app.
import { escapeMd, toMarkdown, type RichDoc } from "./richtext";

/** The lives a copied link may be given, in minutes (the server allows 5–1440). */
export const AGENT_LINK_MINUTES = [15, 60, 240, 1440] as const;

export type IssueCopyHeader = { key: string; title: string; url: string; status: string; type: string | null };
export type IssueCopyAttachment = { name: string; url: string };

/**
 * The Markdown copied for an agent; attachments named twice are listed once.
 * `depth` is its title's heading level (deeper when it sits inside another prompt).
 */
export function issueMarkdown(issue: IssueCopyHeader, doc: RichDoc, attachments: readonly IssueCopyAttachment[], depth = 1): string {
  const h = (level: number) => "#".repeat(Math.min(6, level));
  const byName = new Map<string, string>();
  for (const a of attachments) if (!byName.has(a.name)) byName.set(a.name, a.url);
  const description = toMarkdown(doc, (name) => byName.get(name) ?? null);
  const facts = [`- Tracker: ${issue.url}`, `- Status: ${issue.status}`, ...(issue.type ? [`- Type: ${issue.type}`] : [])];
  const parts = [`${h(depth)} ${issue.key}: ${escapeMd(issue.title)}`, facts.join("\n"), `${h(depth + 1)} Description`, description || "(no description)"];
  if (byName.size > 0) parts.push(`${h(depth + 1)} Attachments`, [...byName].map(([name, url]) => `- [${escapeMd(name)}](${url})`).join("\n"));
  return `${parts.join("\n\n")}\n`;
}
