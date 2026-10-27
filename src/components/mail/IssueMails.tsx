import { useState, type DragEvent } from "react";
import { MailPlus, Pin, Unlink } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/errorText";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { MailCard, type MailView } from "./MailCard";
import { PinMailDialog } from "./PinMailDialog";
import { draftFromDrop, mayCarryMail, type MailDraft } from "./readMail";

/**
 * The mails pinned to an issue: pinned from the button, or by dropping an .eml
 * file or an Outlook link on the section. Each opens in Outlook, goes on the
 * pinboard or lets go of the issue.
 */
export function IssueMails({ issueKey, connectionId }: { issueKey: string; connectionId: number }) {
  const utils = trpc.useUtils();
  const mails = trpc.mails.forIssue.useQuery({ issueKey, connectionId });
  const pin = trpc.mails.pin.useMutation();
  const unpin = trpc.mails.unpin.useMutation();
  const save = trpc.mails.save.useMutation();
  const toBoard = trpc.pinboard.pinMail.useMutation();
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<MailDraft | null>(null);
  const [over, setOver] = useState(false);
  const to = { issueKey, connectionId };

  const refresh = () => Promise.all([utils.mails.forIssue.invalidate(to), utils.mails.recent.invalidate()]);
  const pinHere = async (mail: MailView) => {
    await pin.mutateAsync({ mailId: mail.id, to });
    await refresh();
    toast.success(t("ui.mail.pinned"));
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const draft = await draftFromDrop(e.dataTransfer);
    if (!draft) return toast.error(t("ui.mail.notAMail"));
    // A file says all it needs; a link still lacks its subject.
    if (draft.subject) {
      try {
        await pinHere(await save.mutateAsync(draft));
      } catch (err) {
        toastError(err);
      }
      return;
    }
    setInitial(draft);
    setOpen(true);
  };

  return (
    <div
      onDragOver={e => {
        if (!mayCarryMail(e.dataTransfer)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => void onDrop(e)}
      className={cn("rounded-lg", over && "ring-2 ring-ring ring-offset-2 ring-offset-background")}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setInitial(null);
            setOpen(true);
          }}
        >
          <MailPlus />
          {t("ui.mail.pinAction")}
        </Button>
        <span className="text-caption text-muted-foreground">{t("ui.mail.dropHint")}</span>
      </div>
      {mails.data?.length ? (
        <ul className="grid gap-2">
          {mails.data.map(m => (
            <li key={m.id}>
              <MailCard
                mail={m}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("ui.mail.toBoard", { subject: m.subject })}
                      disabled={toBoard.isPending}
                      onClick={() =>
                        toBoard.mutate(
                          { mailId: m.id },
                          {
                            onSuccess: r => {
                              void utils.pinboard.list.invalidate();
                              toast.success(t("ui.mail.onBoard", { board: r.boardName }));
                            },
                            onError: e => toastError(e),
                          },
                        )
                      }
                    >
                      <Pin />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("ui.mail.unpin", { subject: m.subject })}
                      disabled={unpin.isPending}
                      onClick={() => unpin.mutate({ mailId: m.id, to }, { onSuccess: () => void refresh(), onError: e => toastError(e) })}
                    >
                      <Unlink />
                    </Button>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        mails.isSuccess && <p className="text-body-sm text-muted-foreground">{t("ui.mail.none")}</p>
      )}
      <PinMailDialog open={open} onOpenChange={setOpen} initial={initial} onPick={pinHere} />
    </div>
  );
}
