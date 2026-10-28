import { useState } from "react";
import { Link2, MailPlus, Unlink } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";
import { MailCard, type MailView } from "./MailCard";
import { PinMailDialog } from "./PinMailDialog";

/** A Markdown link to a mail: its subject (brackets escaped), opening it in Outlook. */
const markdownLink = (m: MailView): string => `[✉ ${(m.subject || t("ui.mail.noSubject")).replace(/[[\]\\]/g, c => `\\${c}`)}](${m.webLink ?? ""})`;

/**
 * The mails pinned to a Markdown note, under it. While the note is edited,
 * a mail's link can be written into the text (`onInsert`), and pinning one
 * writes it there too.
 */
export function NoteMails({ noteId, onInsert }: { noteId: string; onInsert?: (markdown: string) => void }) {
  const utils = trpc.useUtils();
  const mails = trpc.mails.forNote.useQuery({ noteId });
  const pin = trpc.mails.pin.useMutation();
  const unpin = trpc.mails.unpin.useMutation();
  const [open, setOpen] = useState(false);

  const pinHere = async (mail: MailView) => {
    await pin.mutateAsync({ mailId: mail.id, to: { noteId } });
    await Promise.all([utils.mails.forNote.invalidate({ noteId }), utils.mails.recent.invalidate()]);
    if (onInsert && mail.webLink) onInsert(markdownLink(mail));
    toast.success(t("ui.mail.pinned"));
  };

  return (
    <section aria-label={t("ui.mail.title")} className="grid min-w-0 gap-2">
      {mails.data?.length ? (
        <ul className="grid gap-1.5">
          {mails.data.map(m => (
            <li key={m.id}>
              <MailCard
                mail={m}
                actions={
                  <>
                    {onInsert && m.webLink && (
                      <Button variant="ghost" size="icon-sm" aria-label={t("ui.mail.insertLink", { subject: m.subject })} onClick={() => onInsert(markdownLink(m))}>
                        <Link2 />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("ui.mail.unpin", { subject: m.subject })}
                      disabled={unpin.isPending}
                      onClick={() => unpin.mutate({ mailId: m.id, to: { noteId } }, { onSuccess: () => void utils.mails.forNote.invalidate({ noteId }), onError: e => toastError(e) })}
                    >
                      <Unlink />
                    </Button>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setOpen(true)}>
        <MailPlus />
        {t("ui.mail.pinAction")}
      </Button>
      <PinMailDialog open={open} onOpenChange={setOpen} onPick={pinHere} />
    </section>
  );
}
