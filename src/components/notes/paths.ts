import type { NoteIssue } from "@contracts/notes";
import { newDraftId } from "./drafts";

/** A new note's page: in a folder or under a note (parentId), maybe about an issue, maybe on a given day. */
export function newNotePath(parentId?: string | null, issue?: NoteIssue | null, notedOn?: string): string {
  const params = new URLSearchParams({ draft: newDraftId() });
  if (parentId) params.set("parentId", parentId);
  if (issue) {
    params.set("issueKey", issue.issueKey);
    params.set("connectionId", String(issue.connectionId));
  }
  if (notedOn) params.set("notedOn", notedOn);
  return `/notes/new?${params}`;
}
