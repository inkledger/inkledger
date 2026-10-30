// Pictures in an idea's text: `![name](idea-file:12)` in its Markdown, the bytes
// kept by the app (an idea lives here, not on a tracker, until it is promoted).

export const IDEA_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const IDEA_FILES_PER_IDEA = 20;
/** All of a user's idea pictures together. */
export const IDEA_FILES_QUOTA_BYTES = 100 * 1024 * 1024;

const REF = /idea-file:(\d+)/g;

/** The picture ids an idea's text refers to, in order, each once. */
export function ideaFileIds(markdown: string): number[] {
  return [...new Set([...markdown.matchAll(REF)].map(m => Number(m[1])))];
}

/** Each `idea-file:<id>` swapped for what `to` gives (a link, a name), or left when it gives nothing. */
export function replaceIdeaFiles(markdown: string, to: (id: number) => string | null): string {
  return markdown.replace(REF, (whole, id: string) => to(Number(id)) ?? whole);
}

/** The Markdown for a picture just added (its name kept readable, brackets out). */
export const ideaFileMarkdown = (id: number, name: string) => `![${name.replace(/[[\]\n]/g, " ").trim() || "image"}](idea-file:${id})`;

/** Where the app serves a picture to its owner. */
export const ideaFileUrl = (id: number) => `/api/ideas/files/${id}`;
