import { failureText, errorText } from "@/lib/errorText";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useProviderName } from "@/hooks/useConnections";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { FieldInput, type Value } from "@/components/issue/FieldInput";

/** Which way on: by its id (picked from the list) or by the status it reaches (a drag on the board). */
export type TransitionTarget = { transitionId: string } | { toStatus: string };

/**
 * Moving an issue on when the way there asks for something: the fields its
 * service wants, filled in here, or, for one inkledger can't fill, the service's
 * own page.
 */
export function TransitionDialog({
  issueKey,
  connectionId,
  target,
  onClose,
  onMoved,
}: {
  issueKey: string;
  connectionId?: number | null;
  target: TransitionTarget | null;
  onClose: () => void;
  onMoved: (r: { moved: string; to: string }) => void;
}) {
  const provider = useProviderName(connectionId);
  // On its own tracker: the same key may be on another one.
  const where = { key: issueKey, connectionId: connectionId ?? undefined };
  const list = trpc.issues.transitions.useQuery(where, { enabled: target !== null, retry: false, staleTime: 0 });
  const [values, setValues] = useState<Record<string, Value>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Bumped by a refusal: after that render, the first refused field takes the focus (not left on Move).
  const [focusRefused, setFocusRefused] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // A fresh form for each ask: another issue, tracker or transition (the Board reuses one
  // dialog for every card), or the same one asked again, never gets the last one's values.
  const identity = target ? `${connectionId ?? ""}:${issueKey}:${"transitionId" in target ? target.transitionId : target.toStatus}` : null;
  const [asked, setAsked] = useState(identity);
  if (asked !== identity) {
    setAsked(identity);
    setValues({});
    setErrors({});
    setError(null);
  }
  const tr = target
    ? list.data?.find(x => ("transitionId" in target ? x.id === target.transitionId : x.toStatus.toLowerCase() === target.toStatus.toLowerCase()))
    : undefined;
  useEffect(() => {
    if (!focusRefused) return;
    const first = tr?.requirements.find(f => errors[f.id]);
    if (first) document.getElementById(`tf-${first.id}`)?.focus();
    // Only on a new refusal (its errors are in this render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRefused]);
  const move = trpc.issues.transition.useMutation({
    onSuccess: r => {
      setValues({});
      onMoved(r);
    },
    onError: e => {
      const fields = (e.data as { fields?: Record<string, string> } | null | undefined)?.fields;
      setErrors(fields ?? {});
      setError(fields ? null : failureText(e));
      // The first refused field takes the focus once drawn with its error (see the effect below).
      if (fields) setFocusRefused(n => n + 1);
    },
  });
  const set = (id: string, v: Value | undefined) =>
    setValues(prev => {
      const next = { ...prev };
      if (v === undefined) delete next[id];
      else next[id] = v;
      return next;
    });

  return (
    <Dialog open={target !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        {!tr ? (
          // Named while it loads or fails: a screen reader says what opened.
          <>
            <DialogHeader>
              <DialogTitle>{t("pages.issueDetail.changeStatus")}</DialogTitle>
              <DialogDescription className="sr-only">{issueKey}</DialogDescription>
            </DialogHeader>
            {list.isPending ? (
              <Spinner className="h-5 w-5" />
            ) : (
              <FormError message={list.error ? errorText(list.error) : null} />
            )}
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("pages.issueDetail.transitionTitle", { status: tr.toStatus })}</DialogTitle>
              <DialogDescription>
                {tr.executable
                  ? t("pages.issueDetail.transitionIntro", { provider, status: tr.toStatus })
                  : t("pages.issueDetail.transitionUnfillable", { provider, status: tr.toStatus })}
              </DialogDescription>
            </DialogHeader>
            {tr.executable ? (
              <form
                className="grid gap-4"
                onSubmit={e => {
                  e.preventDefault();
                  setErrors({});
                  setError(null);
                  move.mutate({ ...where, transitionId: tr.id, fields: values });
                }}
              >
                {tr.requirements.map(f => (
                  <FieldInput key={f.id} field={f} value={values[f.id]} error={errors[f.id]} onChange={v => set(f.id, v)} provider={provider} />
                ))}
                <FormError message={error} />
                <Button type="submit" disabled={move.isPending}>
                  {t("pages.issueDetail.move")}
                </Button>
              </form>
            ) : (
              tr.remoteUrl && (
                <Button asChild variant="outline">
                  <a href={tr.remoteUrl} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    {t("pages.issueDetail.openOnProvider", { provider })}
                  </a>
                </Button>
              )
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
