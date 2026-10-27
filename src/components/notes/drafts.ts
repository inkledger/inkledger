import {
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  type NoteIssue,
} from "@contracts/notes";
import { readStored, readStoredJson, writeStored } from "@/lib/storage";

export type NoteDraft = {
  version: 1;
  userId: number;
  noteId: string | null;
  draftId: string;
  tabId: string;
  baseContentRevision: number;
  title: string;
  body: string;
  parentId: string | null;
  issue: NoteIssue | null;
  updatedAt: number;
};

const PREFIX = "ikl-note-draft:v1:";
const TAB_KEY = "ikl-note-tab:v1";
let memoryTab: string | null = null;

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function newDraftId(): string {
  return uuid();
}

export function noteTabId(): string {
  if (memoryTab) return memoryTab;
  try {
    const existing = sessionStorage.getItem(TAB_KEY);
    if (existing && /^[a-zA-Z0-9-]{8,80}$/.test(existing))
      return (memoryTab = existing);
    memoryTab = uuid();
    sessionStorage.setItem(TAB_KEY, memoryTab);
  } catch {
    memoryTab = uuid();
  }
  return memoryTab;
}

export function draftKey(
  draft: Pick<NoteDraft, "userId" | "noteId" | "draftId" | "tabId">
): string {
  return `${PREFIX}${draft.userId}:${draft.noteId ?? "new"}:${draft.draftId}:${draft.tabId}`;
}

function valid(value: unknown, userId: number): value is NoteDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<NoteDraft>;
  return (
    draft.version === 1 &&
    draft.userId === userId &&
    typeof draft.draftId === "string" &&
    typeof draft.tabId === "string" &&
    (typeof draft.noteId === "string" || draft.noteId === null) &&
    typeof draft.title === "string" &&
    draft.title.length <= NOTE_TITLE_MAX &&
    typeof draft.body === "string" &&
    draft.body.length <= NOTE_BODY_MAX &&
    typeof draft.baseContentRevision === "number" &&
    Number.isInteger(draft.baseContentRevision) &&
    draft.baseContentRevision >= 0 &&
    (typeof draft.parentId === "string" || draft.parentId === null) &&
    typeof draft.updatedAt === "number" &&
    Number.isFinite(draft.updatedAt) &&
    (draft.issue === null ||
      (!!draft.issue &&
        typeof draft.issue.issueKey === "string" &&
        typeof draft.issue.connectionId === "number"))
  );
}

export function readDraft(
  userId: number,
  noteId: string | null,
  draftId: string,
  tabId = noteTabId()
): NoteDraft | null {
  const value = readStoredJson(draftKey({ userId, noteId, draftId, tabId }));
  return valid(value, userId) ? value : null;
}

export function findDraft(
  userId: number,
  noteId: string | null,
  draftId: string
): NoteDraft | null {
  return (
    readDraft(userId, noteId, draftId) ??
    listDrafts(userId).find(
      draft => draft.noteId === noteId && draft.draftId === draftId
    ) ??
    null
  );
}

export function writeDraft(draft: NoteDraft): boolean {
  return writeStored(draftKey(draft), JSON.stringify(draft));
}

export function deleteDraft(
  draft: Pick<NoteDraft, "userId" | "noteId" | "draftId" | "tabId">
): boolean {
  return writeStored(draftKey(draft), null);
}

export function listDrafts(userId: number): NoteDraft[] {
  const result: NoteDraft[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${PREFIX}${userId}:`)) continue;
      const value = readStoredJson(key);
      if (valid(value, userId)) result.push(value);
    }
  } catch {
    return [];
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function storageProbe(): boolean {
  const key = `${PREFIX}probe`;
  const ok = writeStored(key, "1");
  if (ok) writeStored(key, null);
  return ok;
}

export function draftPath(draft: NoteDraft): string {
  if (draft.noteId)
    return `/notes/${draft.noteId}?draft=${encodeURIComponent(draft.draftId)}`;
  const params = new URLSearchParams({ draft: draft.draftId });
  if (draft.parentId) params.set("parentId", draft.parentId);
  if (draft.issue) {
    params.set("issueKey", draft.issue.issueKey);
    params.set("connectionId", String(draft.issue.connectionId));
  }
  return `/notes/new?${params}`;
}

export function draftSummary(draft: NoteDraft): string {
  return readStored(draftKey(draft)) === null ? "" : draft.title;
}
