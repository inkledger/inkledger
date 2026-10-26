import { failureText, errorText } from "@/lib/errorText";
import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useProviderName } from "@/hooks/useConnections";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

type Transitions = inferRouterOutputs<AppRouter>["issues"]["transitions"];
type Field = Transitions[number]["requirements"][number];
type Value = string | number | string[] | { date: string } | { user: string };

/** Which way on: by its id (picked from the list) or by the status it reaches (a drag on the board). */
export type TransitionTarget = { transitionId: string } | { toStatus: string };

function FieldInput({ field, value, error, onChange, provider }: { field: Field; value: Value | undefined; error?: string; onChange: (v: Value | undefined) => void; provider: string }) {
  const id = `tf-${field.id}`;
  const label = (
    <Label htmlFor={id}>
      {field.name}
      {!field.required && <span className="ml-1 font-normal text-muted-foreground">({t("pages.issueDetail.optional")})</span>}
    </Label>
  );
  const err = error && (
    <p className="text-caption text-danger" id={`${id}-error`}>
      {error === "required" ? t("pages.issueDetail.required") : error}
    </p>
  );
  const described = error ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
  switch (field.type) {
    case "choice":
      return (
        <div className="grid gap-2">
          {label}
          <Select value={typeof value === "string" ? value : ""} onValueChange={v => onChange(v)}>
            <SelectTrigger id={id} {...described}>
              <SelectValue placeholder={t("pages.issueDetail.choose")} />
            </SelectTrigger>
            <SelectContent>
              {field.options.map(o => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {err}
        </div>
      );
    case "multiChoice": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <fieldset className="grid gap-2" id={id} tabIndex={-1} {...described}>
          <legend className="mb-1 text-body-sm font-medium">{field.name}</legend>
          {field.options.map(o => (
            <label key={o.id} className="flex items-center gap-2 text-body-sm">
              <Checkbox checked={picked.includes(o.id)} onCheckedChange={on => onChange(on === true ? [...picked, o.id] : picked.filter(x => x !== o.id))} />
              {o.name}
            </label>
          ))}
          {err}
        </fieldset>
      );
    }
    case "text":
      return (
        <div className="grid gap-2">
          {label}
          {field.multiline ? (
            <Textarea id={id} value={typeof value === "string" ? value : ""} onChange={e => onChange(e.target.value || undefined)} {...described} />
          ) : (
            <Input id={id} value={typeof value === "string" ? value : ""} onChange={e => onChange(e.target.value || undefined)} {...described} />
          )}
          {err}
        </div>
      );
    case "number":
      return (
        <div className="grid gap-2">
          {label}
          <Input id={id} type="number" value={typeof value === "number" ? value : ""} onChange={e => onChange(e.target.value === "" ? undefined : Number(e.target.value))} {...described} />
          {err}
        </div>
      );
    case "date":
      return (
        <div className="grid gap-2">
          {label}
          <Input id={id} type="date" value={value && typeof value === "object" && "date" in value ? value.date : ""} onChange={e => onChange(e.target.value ? { date: e.target.value } : undefined)} {...described} />
          {err}
        </div>
      );
    case "user":
      return (
        <div className="grid gap-2">
          {label}
          <Input id={id} value={value && typeof value === "object" && "user" in value ? value.user : ""} onChange={e => onChange(e.target.value ? { user: e.target.value } : undefined)} {...described} />
          <p className="text-caption text-muted-foreground">{t("pages.issueDetail.userHint", { provider })}</p>
          {err}
        </div>
      );
    case "unknown":
      return null;
  }
}

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
  const move = trpc.issues.transition.useMutation({
    onSuccess: r => {
      setValues({});
      onMoved(r);
    },
    onError: e => {
      const fields = (e.data as { fields?: Record<string, string> } | null | undefined)?.fields;
      setErrors(fields ?? {});
      setError(fields ? null : failureText(e));
      // The first refused field takes the focus (its error is tied to it): not left on Move.
      const first = fields && tr?.requirements.find(f => fields[f.id]);
      if (first) requestAnimationFrame(() => document.getElementById(`tf-${first.id}`)?.focus());
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
