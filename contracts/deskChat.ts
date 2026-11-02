import type { CodeToolName } from "./codeTools";
import type { DeskSlot } from "./desk";
import type { RichDoc } from "./richtext";

/**
 * The Desk's chat (docs/work/desk.md, batches 4c and 4d): what POST /api/desk/chat takes and
 * the server-sent events it answers with. Shared by the page and the server.
 */
export const DESK_CHAT_PATH = "/api/desk/chat";
/** What the chat can reach for the issues shown: the projects' repositories, the model's tools. */
export const DESK_CHAT_REACH_PATH = "/api/desk/chat/reach";

/** A turn of the conversation as the page sends it back. */
export type DeskChatTurn = { role: "user" | "assistant"; content: string };

/** A tool the model asked for; the page runs it on the user's machine. */
export type DeskChatToolCall = { name: CodeToolName; arguments: Record<string, unknown> };

/** A message as sent: the plain turns, and the current question's tool rounds. */
export type DeskChatWire =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: DeskChatToolCall[] }
  | { role: "tool"; name: CodeToolName; content: string };

export type DeskChatRequest = {
  panes: readonly DeskSlot[];
  messages: DeskChatWire[];
  /** The tools the page can run now (none: the model answers from the issues alone). */
  tools?: CodeToolName[];
  /** The repositories in reach, by label (never their paths). */
  repos?: string[];
  /** What the page found by itself when the model can't use tools. */
  extracts?: string;
};

/** An issue the model read. */
export type DeskChatIssue = { connectionId: number; key: string; title: string };

export type DeskChatReach = {
  /** The model is set up; it can call tools. */
  model: { on: boolean; tools: boolean };
  /** The projects of the issues shown, with the repository paths attached to them in Settings. */
  projects: { containerId: number; key: string; name: string; repos: { label: string; path: string }[] }[];
  issues: { key: string; title: string }[];
};

export type DeskChatEvent =
  | { event: "context"; data: { issues: DeskChatIssue[] } }
  | { event: "delta"; data: { text: string } }
  /** The answer so far drawn as a document (a few times a second while it is written). */
  | { event: "draft"; data: { doc: RichDoc } }
  | { event: "done"; data: { markdown: string; doc: RichDoc } }
  /** The model wants tools run: the page runs them and asks again with their results. */
  | { event: "tool_calls"; data: { calls: DeskChatToolCall[] } }
  | { event: "error"; data: { message: string } }
  | { event: "off"; data: { message: string } };
