import { toast } from "sonner";
import { fileOf, type MailDraft } from "./readMail";
import { t } from "@/i18n";

/**
 * After a mail from a file is pinned: its whole .eml becomes the copy, when the
 * user keeps copies (docs/work/ideas/mail-copies.md R-1.6). The pin stands
 * whatever happens here; a refusal is said, and kept on the mail by the server.
 */
export async function sendCopy(mailId: number, draft: MailDraft | null | undefined, copies: string | undefined): Promise<void> {
  const file = fileOf(draft);
  if (!file || !copies || copies === "off") return;
  try {
    const res = await fetch(`/api/mail/${mailId}/copy`, { method: "POST", body: file, credentials: "same-origin", headers: { "Content-Type": "message/rfc822" } });
    if (res.ok) return;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    toast.error(t("ui.mail.copy.failed"), { description: body?.error });
  } catch {
    toast.error(t("ui.mail.copy.failed"));
  }
}
