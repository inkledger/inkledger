import type { NoteIssue } from "@contracts/notes";
import { newDraftId } from "./drafts";

/** A new note's page: in a folder or under a note (parentId), maybe about an issue. */
export function newNotePath(parentId?: string | null, issue?: NoteIssue | null): string {
  const params = new URLSearchParams({ draft: newDraftId() });
  if (parentId) params.set("parentId", parentId);
  if (issue) {
    params.set("issueKey", issue.issueKey);
    params.set("connectionId", String(issue.connectionId));
  }
  return `/notes/new?${params}`;
}
