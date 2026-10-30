import { Paperclip } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, PageSpinner } from "@/components/app/States";
import { formatBytes } from "@/lib/initials";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/**
 * A mail's kept copy (docs/work/ideas/mail-copies.md R-1.7): the server's page in a
 * frame that may run nothing and load nothing from outside, then its attachments
 * (downloads, full copies only).
 */
export function MailCopyDialog({ mailId, subject, open, onOpenChange }: { mailId: number; subject: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const info = trpc.mails.copyInfo.useQuery({ id: mailId }, { enabled: open });
  const copy = info.data?.copy;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{subject || t("ui.mail.noSubject")}</DialogTitle>
          <DialogDescription>{t("ui.mail.copy.title")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto">
          {info.isError ? (
            <ErrorState onRetry={() => void info.refetch()} />
          ) : info.isLoading ? (
            <PageSpinner />
          ) : !copy ? (
            <EmptyState title={t("ui.mail.copy.none")} />
          ) : (
            <>
              {/* No allow-* at all: no scripts, forms, navigation or popups (the server's CSP says so too). */}
              <iframe
                sandbox=""
                src={`/api/mail/${mailId}/view`}
                title={t("ui.mail.copy.title")}
                referrerPolicy="no-referrer"
                className="min-h-[50dvh] w-full rounded-md border"
              />
              {copy.attachments.length > 0 && (
                <section aria-label={t("ui.mail.copy.attachments")} className="grid gap-1 text-body-sm">
                  <h3 className="font-medium">{t("ui.mail.copy.attachments")}</h3>
                  {copy.mode === "body" && <p className="text-muted-foreground">{t("ui.mail.copy.bodyOnly")}</p>}
                  <ul className="grid gap-1">
                    {copy.attachments.map(a => (
                      <li key={a.index} className="flex min-w-0 items-center gap-2">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {copy.mode === "full" ? (
                          <a href={`/api/mail/${mailId}/attachment/${a.index}`} download className="truncate font-medium underline-offset-4 hover:underline">
                            {a.name}
                          </a>
                        ) : (
                          <span className="truncate">{a.name}</span>
                        )}
                        <span className="shrink-0 text-caption text-muted-foreground tabular">{formatBytes(a.size)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
