import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Download, KeyRound, LogOut, Mail } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FormError } from "@/components/auth/AuthShell";
import { failureText, toastError } from "@/lib/errorText";
import { mediumDate } from "@/lib/dates";
import { formatBytes } from "@/lib/initials";
import { ErrorState } from "@/components/app/States";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t } from "@/i18n";

const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success(t("settings.outlook.copied")));

/** Settings → Outlook: searching the mailbox from inkledger, and the Outlook add-in. */
export function OutlookSection() {
  return (
    <>
      <MailboxGroup />
      <CopiesGroup />
      <AddinGroup />
    </>
  );
}

type CopyMode = "off" | "body" | "full";

/**
 * Copies of the mails I pin (docs/work/ideas/mail-copies.md R-1.1, R-1.2, R-1.12): off by
 * default, turned on only through a consent dialog the first time; the space they take,
 * and deleting them all. Absent when the server keeps no copies (MAIL_COPIES=off).
 */
function CopiesGroup() {
  const utils = trpc.useUtils();
  const prefs = trpc.settings.get.useQuery();
  const usage = trpc.mails.copyUsage.useQuery();
  const [asking, setAsking] = useState<CopyMode | null>(null);
  const [deleting, setDeleting] = useState(false);
  const update = trpc.settings.update.useMutation({
    onSuccess: data => utils.settings.get.setData(undefined, data),
    onError: e => toastError(e),
  });
  const deleteAll = trpc.mails.deleteAllCopies.useMutation({
    onSuccess: r => {
      void utils.mails.invalidate();
      toast.success(t("settings.outlook.copies.deleted", { count: r.count }));
    },
    onError: e => toastError(e),
  });
  if (usage.data && !usage.data.available) return null;
  const mode = (prefs.data?.mailCopies ?? "off") as CopyMode;
  const choose = (next: CopyMode) => {
    // The first time copies go on, the user says yes knowingly (R-1.2).
    if (next !== "off" && !prefs.data?.mailCopiesConsentAt) return setAsking(next);
    update.mutate({ mailCopies: next });
  };
  return (
    <SettingsGroup id="outlook-copies" title={t("settings.outlook.copies.title")} description={t("settings.outlook.copies.description")} keywords={t("settings.outlook.copies.keywords")}>
      {prefs.isError || usage.isError ? (
        <ErrorState onRetry={() => void Promise.all([prefs.refetch(), usage.refetch()])} />
      ) : !prefs.data || !usage.data ? (
        <Skeleton className="h-20" />
      ) : (
        <div className="grid gap-3">
          <SegmentedControl<CopyMode>
            label={t("settings.outlook.copies.mode")}
            value={mode}
            onChange={choose}
            options={(["off", "body", "full"] as const).map(v => ({ value: v, label: t(`settings.outlook.copies.${v}`) }))}
            className="flex-wrap"
          />
          <div className="flex flex-wrap items-center gap-3 text-body-sm">
            <span className="text-muted-foreground tabular">{t("settings.outlook.copies.usage", { count: usage.data.count, size: formatBytes(usage.data.bytes) })}</span>
            {usage.data.count > 0 && (
              <Button variant="outline" size="sm" disabled={deleteAll.isPending} onClick={() => setDeleting(true)}>
                {t("settings.outlook.copies.deleteAll")}
              </Button>
            )}
          </div>
        </div>
      )}
      <Dialog open={asking !== null} onOpenChange={o => !o && setAsking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.outlook.copies.consentTitle")}</DialogTitle>
            <DialogDescription>{t("settings.outlook.copies.consentBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (asking) update.mutate({ mailCopies: asking, mailCopiesConsent: true });
                setAsking(null);
              }}
            >
              {t("settings.outlook.copies.accept")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.outlook.copies.deleteAll")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.outlook.copies.deleteAllConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => deleteAll.mutate()}>
              {t("settings.outlook.copies.deleteAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

/** Signing in to Microsoft (device code): then "Pin a mail" searches the mailbox. */
function MailboxGroup() {
  const utils = trpc.useUtils();
  const account = trpc.mails.account.useQuery();
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<{ flowId: string; userCode: string; verificationUri: string; intervalSeconds: number } | null>(null);
  const start = trpc.mails.signInStart.useMutation({
    onSuccess: f => {
      setFlow(f);
      window.open(f.verificationUri, "_blank", "noopener");
    },
    onError: e => setError(failureText(e)),
  });
  const signOut = trpc.mails.signOut.useMutation({ onSuccess: () => void utils.mails.account.invalidate(), onError: e => toastError(e) });
  const { mutateAsync: poll } = trpc.mails.signInPoll.useMutation();

  useEffect(() => {
    if (!flow) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = (seconds: number) => {
      timer = setTimeout(() => {
        void poll({ flowId: flow.flowId })
          .then(r => {
            if (stopped) return;
            if (r.state === "pending") return ask(r.retryInSeconds);
            setFlow(null);
            if (r.state === "authorized") {
              toast.success(t("settings.outlook.signedInAs", { account: r.account }));
              void utils.mails.account.invalidate();
              void utils.mails.search.invalidate();
              return;
            }
            setError(t(r.reason === "consent" ? "settings.outlook.consent" : r.reason === "denied" ? "settings.outlook.denied" : "settings.outlook.expired"));
          })
          .catch((e: unknown) => {
            if (stopped) return;
            setFlow(null);
            setError(failureText(e));
          });
      }, seconds * 1000);
    };
    ask(flow.intervalSeconds);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [flow, poll, utils]);

  return (
    <SettingsGroup id="outlook-mailbox" title={t("settings.outlook.mailboxTitle")} description={t("settings.outlook.mailboxText")} keywords={t("settings.outlook.mailboxKeywords")}>
      {account.isPending ? (
        <Skeleton className="h-9 w-48" />
      ) : !account.data?.available ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.outlook.notConfigured")}</p>
      ) : account.data.account ? (
        <div className="flex flex-wrap items-center gap-3">
          <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-body-sm">{t("settings.outlook.signedInAs", { account: account.data.account.displayName ?? account.data.account.account })}</span>
          <Button variant="outline" size="sm" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            <LogOut />
            {t("settings.outlook.signOut")}
          </Button>
        </div>
      ) : flow ? (
        <div className="grid max-w-md gap-3">
          <p className="text-body-sm text-muted-foreground">{t("settings.outlook.code")}</p>
          <p className="text-title tabular-nums tracking-[0.2em]" data-testid="mail-user-code">
            {flow.userCode}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={flow.verificationUri} target="_blank" rel="noreferrer">
                {t("settings.outlook.open")}
              </a>
            </Button>
            <Button variant="outline" onClick={() => copy(flow.userCode)}>
              <Copy />
              {t("settings.outlook.copyCode")}
            </Button>
          </div>
          <p className="text-caption text-muted-foreground" role="status">
            {t("settings.outlook.waiting")}
          </p>
        </div>
      ) : (
        <div className="grid max-w-md gap-2">
          <FormError message={error} />
          <Button
            className="justify-self-start"
            onClick={() => {
              setError(null);
              start.mutate();
            }}
            disabled={start.isPending}
          >
            <Mail />
            {t("settings.outlook.signIn")}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
}

/** The manifest's address: this page's own when it is on HTTPS, else the local HTTPS proxy's. */
function manifestUrl(): string {
  const base = window.location.protocol === "https:" ? window.location.origin : "https://localhost:3443";
  return `${base}/api/outlook/manifest.xml`;
}

/** The add-in: how to install it, and the key it pins with. */
function AddinGroup() {
  const utils = trpc.useUtils();
  const key = trpc.mails.addinKey.useQuery();
  const [shown, setShown] = useState<string | null>(null);
  const make = trpc.mails.newAddinKey.useMutation({
    onSuccess: r => {
      setShown(r.key);
      void utils.mails.addinKey.invalidate();
    },
    onError: e => toastError(e),
  });
  const revoke = trpc.mails.revokeAddinKey.useMutation({
    onSuccess: () => {
      setShown(null);
      void utils.mails.addinKey.invalidate();
    },
    onError: e => toastError(e),
  });
  const url = manifestUrl();

  return (
    <SettingsGroup id="outlook-addin" title={t("settings.outlook.addinTitle")} description={t("settings.outlook.addinText")} keywords={t("settings.outlook.addinKeywords")}>
      <ol className="grid max-w-prose list-decimal gap-2 pl-5 text-body-sm">
        <li>{t("settings.outlook.step1")}</li>
        <li>
          {t("settings.outlook.step2")}
          <div className="mt-1.5 flex max-w-md gap-2">
            <Input readOnly value={url} aria-label={t("settings.outlook.manifest")} onFocus={e => e.currentTarget.select()} />
            <Button variant="outline" onClick={() => copy(url)} aria-label={t("settings.outlook.copyManifest")}>
              <Copy />
            </Button>
          </div>
          <Button asChild variant="outline" size="sm" className="mt-2">
            {/* The server sends it as an attachment, from the HTTPS address the add-in will be served at. */}
            <a href={url} download="inkledger-outlook.xml">
              <Download />
              {t("settings.outlook.downloadManifest")}
            </a>
          </Button>
        </li>
        <li>{t("settings.outlook.step3")}</li>
      </ol>

      <div className="mt-4 grid max-w-md gap-2">
        {shown ? (
          <>
            <p className="text-body-sm">{t("settings.outlook.keyOnce")}</p>
            <div className="flex gap-2">
              <Input readOnly value={shown} aria-label={t("settings.outlook.key")} onFocus={e => e.currentTarget.select()} />
              <Button variant="outline" onClick={() => copy(shown)} aria-label={t("settings.outlook.copyKey")}>
                <Copy />
              </Button>
            </div>
          </>
        ) : key.data ? (
          <p className="text-body-sm text-muted-foreground">
            {key.data.lastUsedAt ? t("settings.outlook.keyUsed", { date: mediumDate(key.data.lastUsedAt) }) : t("settings.outlook.keyUnused")}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant={key.data ? "outline" : "default"} onClick={() => make.mutate()} disabled={make.isPending}>
            <KeyRound />
            {key.data ? t("settings.outlook.keyRenew") : t("settings.outlook.keyMake")}
          </Button>
          {key.data && (
            <Button variant="ghost" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
              {t("settings.outlook.keyRevoke")}
            </Button>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}
