import type { RichDoc } from "./richtext";

export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 65_000;
export const NOTE_SEARCH_MIN = 2;
export const NOTE_SEARCH_MAX = 200;
export const NOTE_SEARCH_SNAPSHOT_MAX = 200;
export const NOTE_MAX_DEPTH = 32;
export const NOTE_MAX_SUBTREE = 5_000;
export const NOTE_TRASH_DAYS = 30;
export const NOTE_VERSION_DAYS = 30;
export const NOTE_VERSION_MAX = 50;

/** A note holds Markdown; a folder only groups (notes and folders), and never sits in a note. */
export const NOTE_KINDS = ["note", "folder"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** A stored kind as the type (the column is checked to these two). */
export const noteKind = (value: string): NoteKind => (value === "folder" ? "folder" : "note");

export const NOTE_FILTERS = ["all", "free", "linked"] as const;
export type NoteFilter = (typeof NOTE_FILTERS)[number];
export type NoteVersionOrigin =
  "auto" | "manual" | "conflict" | "delete" | "restore";
export type NoteChange =
  "create" | "content" | "move" | "issue" | "delete" | "restore" | "version";

export type NoteIssue = { connectionId: number; issueKey: string };

export type NoteTreeItem = {
  id: string;
  parentId: string | null;
  kind: NoteKind;
  position: number;
  title: string;
  contentRevision: number;
  connectionId: number | null;
  issueKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NoteDocument = NoteTreeItem & {
  body: string;
  doc: RichDoc;
};

export type NoteConflict = {
  status: "conflict";
  current: NoteDocument;
};

export type NoteUpdated = {
  status: "updated";
  note: NoteDocument;
};

export type NoteSearchResult = {
  id: string;
  kind: NoteKind;
  title: string;
  snippet: string;
  path: { id: string; title: string }[];
  connectionId: number | null;
  issueKey: string | null;
  updatedAt: Date;
};
