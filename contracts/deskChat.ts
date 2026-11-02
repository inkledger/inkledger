import type { RichDoc } from "./richtext";

/**
 * The Desk's chat (docs/work/desk.md, batch 4c): what POST /api/desk/chat takes and the
 * server-sent events it answers with. Shared by the page and the server.
 */
export const DESK_CHAT_PATH = "/api/desk/chat";

/** A turn of the conversation as the page sends it back. */
export type DeskChatTurn = { role: "user" | "assistant"; content: string };

/** An issue the model read. */
export type DeskChatIssue = { connectionId: number; key: string; title: string };

export type DeskChatEvent =
  | { event: "context"; data: { issues: DeskChatIssue[] } }
  | { event: "delta"; data: { text: string } }
  /** The answer so far drawn as a document (a few times a second while it is written). */
  | { event: "draft"; data: { doc: RichDoc } }
  | { event: "done"; data: { markdown: string; doc: RichDoc } }
  | { event: "error"; data: { message: string } }
  | { event: "off"; data: { message: string } };
