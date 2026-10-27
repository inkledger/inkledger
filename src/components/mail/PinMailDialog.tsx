import { useId, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";
import { MailCard, type MailView } from "./MailCard";
import { draftFromFile, draftFromLink, type MailDraft } from "./readMail";

/**
 * Choose the mail to pin: paste its Outlook link (then type its subject: a link
 * does not tell it), pick its .eml file, or take one kept already. `onPick` gets
 * the saved mail; the caller pins it where it belongs.
 */
export function PinMailDialog({
  open,
  onOpenChange,
  onPick,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (mail: MailView) => Promise<void> | void;
  /** A mail already read from a drop: the dialog only asks what is missing. */
  initial?: MailDraft | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted while open: each opening starts afresh. */}
        {open && (
          <PinMail
            onClose={() => onOpenChange(false)}
            onPick={onPick}
            initial={initial ?? null}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PinMail({
  onClose,
  onPick,
  initial,
}: {
  onClose: () => void;
  onPick: (mail: MailView) => Promise<void> | void;
  initial: MailDraft | null;
}) {
  const [draft, setDraft] = useState<MailDraft | null>(initial);
  const [link, setLink] = useState("");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const ids = useId();
  const recent = trpc.mails.recent.useQuery({ query: query || undefined });
  const save = trpc.mails.save.useMutation();

  const pick = async (mail: MailView) => {
    setBusy(true);
    try {
      await onPick(mail);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const d = draft ?? draftFromLink(link);
    if (!d) return;
    try {
      const mail = await save.mutateAsync({
        ...d,
        subject: subject.trim() || d.subject,
      });
      await pick(mail);
    } catch (e) {
      toastError(e);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const d = await draftFromFile(f);
    if (!d) return toastError(new Error(t("ui.mail.notAMail")));
    setDraft(d);
    setSubject(d.subject);
  };

  const linkDraft = draft ?? (link ? draftFromLink(link) : null);
  const linkInvalid = !draft && link.trim() !== "" && !linkDraft;
  const canSave =
    !!linkDraft &&
    (subject.trim() !== "" || linkDraft.subject !== "") &&
    !busy &&
    !save.isPending;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("ui.mail.pinTitle")}</DialogTitle>
        <DialogDescription>{t("ui.mail.pinText")}</DialogDescription>
      </DialogHeader>

      <form
        className="grid gap-3"
        onSubmit={e => {
          e.preventDefault();
          void submit();
        }}
      >
        {draft?.source === "eml" ? (
          <MailCard
            mail={{
              id: 0,
              subject: draft.subject,
              fromName: draft.fromName,
              fromAddress: draft.fromAddress,
              receivedAt: draft.receivedAt ? new Date(draft.receivedAt) : null,
              webLink: null,
            }}
          />
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-link`}>{t("ui.mail.link")}</Label>
            <div className="flex gap-2">
              <Input
                id={`${ids}-link`}
                value={draft?.webLink ?? link}
                readOnly={!!draft}
                placeholder="https://outlook.office.com/mail/…"
                aria-invalid={linkInvalid || undefined}
                onChange={e => setLink(e.target.value)}
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => file.current?.click()}
              >
                <FileUp />
                {t("ui.mail.eml")}
              </Button>
              <input
                ref={file}
                type="file"
                accept=".eml,message/rfc822"
                hidden
                onChange={e => void onFile(e.target.files?.[0])}
              />
            </div>
            <p className="text-caption text-muted-foreground">
              {linkInvalid ? t("ui.mail.notOutlook") : t("ui.mail.linkHint")}
            </p>
          </div>
        )}
        {linkDraft && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-subject`}>{t("ui.mail.subject")}</Label>
            <Input
              id={`${ids}-subject`}
              value={subject}
              maxLength={500}
              onChange={e => setSubject(e.target.value)}
              autoFocus={!!draft}
            />
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {t("ui.mail.pin")}
          </Button>
        </DialogFooter>
      </form>

      {!draft && (
        <div className="grid gap-2 border-t pt-3">
          <Label htmlFor={`${ids}-recent`}>{t("ui.mail.recent")}</Label>
          <Input
            id={`${ids}-recent`}
            value={query}
            placeholder={t("ui.mail.searchRecent")}
            onChange={e => setQuery(e.target.value)}
          />
          {recent.data?.length ? (
            <ul className="grid max-h-56 gap-1 overflow-y-auto">
              {recent.data.map(m => (
                <li key={m.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void pick(m)}
                    className="w-full rounded-md p-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MailCard mail={{ ...m, webLink: null }} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-caption text-muted-foreground">
              {t("ui.mail.noRecent")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
