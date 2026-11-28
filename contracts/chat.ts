// Chats about an issue between teammates on this server (the Chat tab of Notifications,
// the Chat section of an issue): what a thread is anchored to, what a message may carry,
// and the limits both sides check. Shared by the page and the API (no zod here: the page's first
// load carries this; the API's checks are in contracts/chatSchemas.ts).
import type { RichDoc } from "./richtext";

/** A thread is open, or resolved (the question had its answer); a new message opens it again. */
export const CHAT_THREAD_STATES = ["open", "resolved"] as const;
export type ChatThreadState = (typeof CHAT_THREAD_STATES)[number];

/** What a thread list narrows to. */
export const CHAT_FILTERS = ["unread", "all", "resolved", "archived"] as const;
export type ChatFilter = (typeof CHAT_FILTERS)[number];

/** A member's place: whoever opened the thread, or someone in it. */
export const CHAT_ROLES = ["owner", "member"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/** The reactions a message takes: a closed set, so a reaction is a meaning, not decoration. */
export const CHAT_REACTIONS = ["👍", "✅", "👀", "❓", "🎉", "❤️"] as const;
export type ChatReaction = (typeof CHAT_REACTIONS)[number];

/** A message's text, at most this long: what a tracker comment takes, so publishing it never fails on length. */
export const CHAT_BODY_MAX = 10_000;
/** Messages per page. */
export const CHAT_PAGE = 50;
/** Threads per page of the list. */
export const CHAT_THREADS_PAGE = 50;
/** People in one thread. */
export const CHAT_MEMBERS_MAX = 20;
/** One file, at most this many bytes. */
export const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Files in one message. */
export const CHAT_FILES_PER_MESSAGE = 10;
/** Every file of one thread together. */
export const CHAT_THREAD_QUOTA_BYTES = 200 * 1024 * 1024;
/** A file uploaded and never sent goes after this long. */
export const CHAT_DRAFT_FILE_TTL_MS = 24 * 3600_000;
/** How long "is typing" holds without a new keystroke. */
export const CHAT_TYPING_MS = 6_000;
/** The shortest gap between two typing signals from one page. */
export const CHAT_TYPING_EVERY_MS = 2_000;
/** Search: the shortest text looked for, and the most results. */
export const CHAT_SEARCH_MIN = 2;
export const CHAT_SEARCH_MAX = 100;

/** Cards in one message. */
export const CHAT_REFS_MAX = 10;

/**
 * A card in a message (contracts/chatSchemas.ts checks one): an issue as its sender saw it (the
 * reader may not have it imported), a worklog its author chose to show (date, time and words,
 * nothing else of theirs), or a tracker comment quoted ("Discuss in chat").
 */
export type ChatRef =
  | { kind: "issue"; key: string; title: string; status: string; category: string }
  | { kind: "worklog"; key: string; date: string; seconds: number; comment: string }
  | { kind: "comment"; key: string; commentId: string; author: string; created: string; excerpt: string };

/** What a system line says happened. */
export type ChatSystemEvent =
  | { kind: "opened" }
  | { kind: "added"; userIds: number[] }
  | { kind: "left" }
  | { kind: "resolved" }
  | { kind: "reopened" }
  | { kind: "published"; messageId: number };

/** Why a teammate can't be asked into a thread (null: they can). */
export type ChatIneligible = "noConnection" | "disabled";

/** A teammate as the picker shows them. */
export type ChatCandidate = {
  id: number;
  name: string;
  avatarUrl: string | null;
  teams: string[];
  ineligible: ChatIneligible | null;
};

/** A person in a thread. */
export type ChatMemberView = {
  userId: number;
  name: string;
  avatarUrl: string | null;
  role: ChatRole;
  /** The last message they read (0: none). */
  lastReadId: number;
  /** Gone from the thread (left, or the account erased). */
  left: boolean;
};

/** The issue a thread is about, as the reader sees it. */
export type ChatIssueView = {
  trackerType: string;
  trackerBase: string;
  remoteId: string;
  key: string;
  title: string;
  status: string;
  category: string;
  /** The reader's own connection to it, or null (none any more). */
  connectionId: number | null;
};

/** A thread in the list. */
export type ChatThreadView = {
  id: number;
  issue: ChatIssueView;
  state: ChatThreadState;
  members: ChatMemberView[];
  /** The latest line: its words (plain), or how many files it carried when it had none. */
  last: { id: number; authorId: number | null; preview: string; at: number; kind: "text" | "system"; files: number } | null;
  unread: number;
  muted: boolean;
  pinned: boolean;
  archived: boolean;
  lastMessageAt: number;
  createdAt: number;
};

/** A file in a message. */
export type ChatFileView = { id: number; name: string; contentType: string; size: number; width: number | null; height: number | null };

/** A message as the thread shows it. */
export type ChatMessageView = {
  id: number;
  threadId: number;
  authorId: number | null;
  kind: "text" | "system";
  body: string;
  /** The body as a rich-text tree (Markdown read on the server), for RichText; null for a system line or no words. */
  doc: RichDoc | null;
  system: ChatSystemEvent | null;
  refs: ChatRef[];
  files: ChatFileView[];
  replyTo: { id: number; authorId: number | null; preview: string; deleted: boolean } | null;
  reactions: { emoji: ChatReaction; userIds: number[] }[];
  jiraCommentId: string | null;
  clientNonce: string | null;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
};

export const isChatReaction = (s: string): s is ChatReaction => (CHAT_REACTIONS as readonly string[]).includes(s);

/** The first line of a message, plain, for a list or a reply: markdown marks dropped, cut at `max`. */
export function chatPreview(body: string, max = 140): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}
