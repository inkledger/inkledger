import { useState, type ReactNode } from "react";
import { Archive, Download, Mail, MoreHorizontal, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { surface } from "@/components/app/surface";
import { ExternalLink } from "@/components/app/ExternalLink";
import { Chip } from "@/components/app/Chip";
import { lazyPart } from "@/components/app/lazyPart";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { mediumDate } from "@/lib/dates";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

const MailCopyDialog = lazyPart(() => import("@/components/mail/MailCopyDialog").then(m => m.MailCopyDialog));

/** A pinned mail as the pages show it, with what is known of its copy (docs/work/ideas/mail-copies.md). */
export type MailView = {
  id: number;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: Date | null;
  webLink: string | null;
  /** The kept copy's mode, null when none (absent: not known here) */
  copyMode?: "body" | "full" | null;
  copyError?: string | null;
  /** Not in the mailbox any more */
  goneAt?: Date | null;
};

/** Who sent it and when, for the line under the subject. */
function mailByline(m: MailView): string {
  return [m.fromName ?? m.fromAddress, m.receivedAt ? mediumDate(m.receivedAt) : null].filter(Boolean).join(" · ");
}

/**
 * A mail: its subject opens it in Outlook (asking first when the domain is not
 * allowed yet, where "Allow always" is one click), sender and date under it.
 * When a copy is kept: chips say so (and when the mail is gone from Outlook, the
 * subject opens the copy instead), and a menu opens, downloads or deletes it.
 */
export function MailCard({ mail, actions, className }: { mail: MailView; actions?: ReactNode; className?: string }) {
  const subject = mail.subject || t("ui.mail.noSubject");
  const [viewing, setViewing] = useState(false);
  const hasCopy = !!mail.copyMode;
  const gone = !!mail.goneAt;
  return (
    <div className={cn("flex min-w-0 items-start gap-2.5", className)}>
      <span aria-hidden {...surface("picture")} className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Mail className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {hasCopy && (gone || !mail.webLink) ? (
          <button type="button" className="text-left font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline" onClick={() => setViewing(true)}>
            {subject}
          </button>
        ) : mail.webLink ? (
          <ExternalLink url={mail.webLink} className="font-medium">
            {subject}
          </ExternalLink>
        ) : (
          <span className="font-medium [overflow-wrap:anywhere]" title={t("ui.mail.noLink")}>
            {subject}
          </span>
        )}
        <p className="truncate text-caption text-muted-foreground">{mailByline(mail) || t("ui.mail.unknownSender")}</p>
        {(hasCopy || gone || mail.copyError) && <CopyChips mail={mail} />}
      </div>
      {(hasCopy || actions) && (
        <div className="flex shrink-0 items-center gap-0.5">
          {hasCopy && <CopyMenu mail={mail} onOpen={() => setViewing(true)} />}
          {actions}
        </div>
      )}
      {hasCopy && viewing && <MailCopyDialog mailId={mail.id} subject={mail.subject} open={viewing} onOpenChange={setViewing} />}
    </div>
  );
}

/** What the card says of the copy: kept, gone from Outlook, or not saved (with Retry). */
function CopyChips({ mail }: { mail: MailView }) {
  const utils = trpc.useUtils();
  const retry = trpc.mails.retryCopy.useMutation({
    onSuccess: () => void utils.mails.invalidate(),
    onError: e => toastError(e),
  });
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {mail.copyMode && <Chip>{t("ui.mail.copy.saved")}</Chip>}
      {mail.goneAt && <Chip tone="warning">{t("ui.mail.copy.gone")}</Chip>}
      {mail.copyError && !mail.copyMode && (
        <>
          <span title={mail.copyError}>
            <Chip tone="danger">{t("ui.mail.copy.failed")}</Chip>
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-1.5" disabled={retry.isPending} onClick={() => retry.mutate({ id: mail.id })}>
            <RotateCw className="h-3 w-3" aria-hidden /> {t("ui.mail.copy.retry")}
          </Button>
        </>
      )}
    </div>
  );
}

function CopyMenu({ mail, onOpen }: { mail: MailView; onOpen: () => void }) {
  const utils = trpc.useUtils();
  const remove = trpc.mails.deleteCopy.useMutation({
    onSuccess: () => {
      void utils.mails.invalidate();
      void utils.todos.invalidate();
      void utils.pinboard.list.invalidate();
      toast.success(t("ui.mail.copy.deleted"));
    },
    onError: e => toastError(e),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("ui.mail.copy.menu", { subject: mail.subject || t("ui.mail.noSubject") })}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpen}>
          <Archive className="h-4 w-4" /> {t("ui.mail.copy.open")}
        </DropdownMenuItem>
        {mail.copyMode === "full" && (
          <DropdownMenuItem asChild>
            <a href={`/api/mail/${mail.id}/eml`} download>
              <Download className="h-4 w-4" /> {t("ui.mail.copy.download")}
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="text-danger" onSelect={() => remove.mutate({ id: mail.id })}>
          <Trash2 className="h-4 w-4" /> {t("ui.mail.copy.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A mail's subject where space is short (a TODO, a post-it): the Outlook link, or
 * the kept copy when the mail is gone from Outlook (or has no link); with a copy
 * kept, a small button opens it too.
 */
export function MailSubject({ mail, className }: { mail: Pick<MailView, "id" | "subject" | "webLink" | "copyMode" | "goneAt">; className?: string }) {
  const [viewing, setViewing] = useState(false);
  const subject = mail.subject || t("ui.mail.noSubject");
  const hasCopy = !!mail.copyMode;
  return (
    <>
      {hasCopy && (mail.goneAt || !mail.webLink) ? (
        <button type="button" className={cn("text-left underline-offset-4 hover:underline", className)} onClick={() => setViewing(true)}>
          {subject}
        </button>
      ) : mail.webLink ? (
        <ExternalLink url={mail.webLink} className={className}>
          {subject}
        </ExternalLink>
      ) : (
        <span className={className}>{subject}</span>
      )}
      {hasCopy && (
        <button
          type="button"
          className="inline-flex shrink-0 items-center rounded-sm text-current opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("ui.mail.copy.open")}
          title={mail.goneAt ? t("ui.mail.copy.gone") : t("ui.mail.copy.saved")}
          onClick={() => setViewing(true)}
        >
          <Archive className="h-3 w-3" aria-hidden />
        </button>
      )}
      {hasCopy && viewing && <MailCopyDialog mailId={mail.id} subject={mail.subject} open={viewing} onOpenChange={setViewing} />}
    </>
  );
}

