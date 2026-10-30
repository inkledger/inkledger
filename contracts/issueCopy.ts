// An issue as an agent gets it, pasted by hand (docs/work/ideas/issue-copy.md R-6.1):
// a header, the description, every attachment as a link through this app.
import { escapeMd, toMarkdown, type RichDoc } from "./richtext";

export type IssueCopyHeader = { key: string; title: string; url: string; status: string; type: string | null };
export type IssueCopyAttachment = { name: string; url: string };

/** The Markdown copied for an agent; attachments named twice are listed once. */
export function issueMarkdown(issue: IssueCopyHeader, doc: RichDoc, attachments: readonly IssueCopyAttachment[]): string {
  const byName = new Map<string, string>();
  for (const a of attachments) if (!byName.has(a.name)) byName.set(a.name, a.url);
  const description = toMarkdown(doc, (name) => byName.get(name) ?? null);
  const facts = [`- Tracker: ${issue.url}`, `- Status: ${issue.status}`, ...(issue.type ? [`- Type: ${issue.type}`] : [])];
  const parts = [`# ${issue.key}: ${escapeMd(issue.title)}`, facts.join("\n"), "## Description", description || "(no description)"];
  if (byName.size > 0) parts.push("## Attachments", [...byName].map(([name, url]) => `- [${escapeMd(name)}](${url})`).join("\n"));
  return `${parts.join("\n\n")}\n`;
}
