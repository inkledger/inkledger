import { toastError } from "@/lib/errorText";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";

type Target = { issueKey: string; connectionId?: number | null };

/** After a change: the issue page, lists and description read again. */
function useAfterChange(done: () => void) {
  const utils = trpc.useUtils();
  return () => {
    toast.success(t("views.issue.manage.saved"));
    void Promise.all([
      utils.issues.get.invalidate(),
      utils.issues.list.invalidate(),
      utils.issues.all.invalidate(),
      utils.issues.description.invalidate(),
    ]);
    done();
  };
}

/** A small "change" button beside a detail. */
function EditButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Pencil className="h-3.5 w-3.5" />
    </Button>
  );
}

/** Who works on the issue: me, others, nobody. */
export function AssigneesEditor(target: Target) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <EditButton
        label={t("views.issue.manage.assignees")}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("views.issue.manage.assigneesTitle", { key: target.issueKey })}
            </DialogTitle>
            <DialogDescription>
              {t("views.issue.manage.assigneesHint")}
            </DialogDescription>
          </DialogHeader>
          {open && <AssigneesForm {...target} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AssigneesForm({
  issueKey,
  connectionId,
  onDone,
}: Target & { onDone: () => void }) {
  const where = { key: issueKey, connectionId: connectionId ?? undefined };
  const people = trpc.issues.assignable.useQuery(where);
  const issue = trpc.issues.get.useQuery(where);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const after = useAfterChange(onDone);
  const assign = trpc.issues.assign.useMutation({
    onSuccess: after,
    onError: e => toastError(e),
  });
  if (people.isPending || issue.isPending)
    return (
      <p className="text-body-sm text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  const current = new Set(
    (people.data ?? [])
      .filter(p => p.remoteId === issue.data?.assigneeId)
      .map(p => p.remoteId)
  );
  const chosen = picked ?? current;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        assign.mutate({
          ...where,
          people: (people.data ?? [])
            .filter(p => chosen.has(p.remoteId))
            .map(p => ({
              remoteId: p.remoteId,
              name: p.name,
              handle: p.handle,
            })),
        });
      }}
    >
      <ul className="grid max-h-72 gap-1.5 overflow-y-auto">
        {people.data?.map(p => (
          <li key={p.remoteId}>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={chosen.has(p.remoteId)}
                onCheckedChange={on => toggle(p.remoteId, on === true)}
              />
              {p.name}
              {p.handle && p.handle !== p.name && (
                <span className="text-muted-foreground">@{p.handle}</span>
              )}
              {p.isMe && (
                <span className="text-caption text-muted-foreground">
                  {t("pages.issueDetail.you")}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <Button type="submit" disabled={assign.isPending}>
        {t("common.save")}
      </Button>
    </form>
  );
}

/** The issue's labels, from those its container offers. */
export function LabelsEditor(target: Target & { labels: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <EditButton
        label={t("views.issue.manage.labels")}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("views.issue.manage.labelsTitle", { key: target.issueKey })}
            </DialogTitle>
          </DialogHeader>
          {open && <LabelsForm {...target} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function LabelsForm({
  issueKey,
  connectionId,
  labels,
  onDone,
}: Target & { labels: string[]; onDone: () => void }) {
  const where = { key: issueKey, connectionId: connectionId ?? undefined };
  const options = trpc.issues.labelOptions.useQuery(where);
  const [chosen, setChosen] = useState(new Set(labels));
  const after = useAfterChange(onDone);
  const save = trpc.issues.setLabels.useMutation({
    onSuccess: after,
    onError: e => toastError(e),
  });
  if (options.isPending)
    return (
      <p className="text-body-sm text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  const all = [...new Set([...(options.data ?? []), ...labels])].sort((a, b) =>
    a.localeCompare(b)
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        save.mutate({ ...where, labels: [...chosen] });
      }}
    >
      <ul className="grid max-h-72 gap-1.5 overflow-y-auto">
        {all.map(l => (
          <li key={l}>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={chosen.has(l)}
                onCheckedChange={on => {
                  const next = new Set(chosen);
                  if (on === true) next.add(l);
                  else next.delete(l);
                  setChosen(next);
                }}
              />
              {l}
            </label>
          </li>
        ))}
      </ul>
      <Button type="submit" disabled={save.isPending}>
        {t("common.save")}
      </Button>
    </form>
  );
}

/** Title and description, written in Markdown. */
export function EditIssueButton(target: Target & { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil />
        {t("views.issue.manage.edit")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("views.issue.manage.editTitle", { key: target.issueKey })}
            </DialogTitle>
            <DialogDescription>
              {t("views.issue.manage.editHint")}
            </DialogDescription>
          </DialogHeader>
          {open && <EditForm {...target} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditForm({
  issueKey,
  connectionId,
  title,
  onDone,
}: Target & { title: string; onDone: () => void }) {
  const where = { key: issueKey, connectionId: connectionId ?? undefined };
  const description = trpc.issues.description.useQuery(where);
  const [draft, setDraft] = useState<{ title: string; body: string | null }>({
    title,
    body: null,
  });
  const after = useAfterChange(onDone);
  const save = trpc.issues.edit.useMutation({
    onSuccess: after,
    onError: e => toastError(e),
  });
  if (description.isPending)
    return (
      <p className="text-body-sm text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  const body = draft.body ?? description.data?.text ?? "";
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        save.mutate({
          ...where,
          ...(draft.title !== title ? { title: draft.title } : {}),
          ...(draft.body !== null ? { body: draft.body } : {}),
        });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="edit-issue-title">
          {t("views.issue.manage.titleLabel")}
        </Label>
        <Input
          id="edit-issue-title"
          value={draft.title}
          onChange={e => setDraft({ ...draft, title: e.target.value })}
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-issue-body">
          {t("views.issue.manage.bodyLabel")}
        </Label>
        <Textarea
          id="edit-issue-body"
          rows={12}
          value={body}
          onChange={e => setDraft({ ...draft, body: e.target.value })}
        />
      </div>
      <Button
        type="submit"
        disabled={save.isPending || draft.title.trim() === ""}
      >
        {t("common.save")}
      </Button>
    </form>
  );
}
