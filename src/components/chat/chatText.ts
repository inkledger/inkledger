import type { ChatMemberView } from "@contracts/chat";
import { INTL_TAG } from "@contracts/i18n";
import { currentLocale, t } from "@/i18n";

/** The Chat tab with a thread open (Back returns where it was opened from). */
export const chatPath = (threadId: number) => `/notifications?tab=chat&thread=${threadId}&cdetail`;

/** A chat file's address (sent ones to the thread's members, a draft to its uploader). */
export const chatFileUrl = (id: number, download = false) => `/api/chat/files/${id}${download ? "?download=1" : ""}`;

/** Someone in a thread by id, as the thread names them ("You" for the reader). */
export function nameIn(members: readonly ChatMemberView[], id: number | null, self: number | null): string {
  if (id === null) return t("pages.chat.removedUser");
  if (id === self) return t("pages.chat.you");
  return members.find((m) => m.userId === id)?.name || t("pages.chat.removedUser");
}

/** "Ann, Bob and 2 more". */
export function namesList(names: string[], max = 3): string {
  if (names.length <= max) return new Intl.ListFormat(INTL_TAG[currentLocale()], { type: "conjunction" }).format(names);
  return t("pages.chat.and", { names: names.slice(0, max).join(", "), count: names.length - max });
}
