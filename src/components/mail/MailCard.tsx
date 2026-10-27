import type { ReactNode } from "react";
import { Mail } from "lucide-react";
import { surface } from "@/components/app/surface";
import { ExternalLink } from "@/components/app/ExternalLink";
import { mediumDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/** A pinned mail as the pages show it. */
export type MailView = {
  id: number;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: Date | null;
  webLink: string | null;
};

/** Who sent it and when, for the line under the subject. */
function mailByline(m: MailView): string {
  return [m.fromName ?? m.fromAddress, m.receivedAt ? mediumDate(m.receivedAt) : null].filter(Boolean).join(" · ");
}

/**
 * A mail: its subject opens it in Outlook (asking first when the domain is not
 * allowed yet, where "Allow always" is one click), sender and date under it.
 */
export function MailCard({ mail, actions, className }: { mail: MailView; actions?: ReactNode; className?: string }) {
  const subject = mail.subject || t("ui.mail.noSubject");
  return (
    <div className={cn("flex min-w-0 items-start gap-2.5", className)}>
      <span aria-hidden {...surface("picture")} className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Mail className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {mail.webLink ? (
          <ExternalLink url={mail.webLink} className="font-medium">
            {subject}
          </ExternalLink>
        ) : (
          <span className="font-medium" title={t("ui.mail.noLink")}>
            {subject}
          </span>
        )}
        <p className="truncate text-caption text-muted-foreground">{mailByline(mail) || t("ui.mail.unknownSender")}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}
