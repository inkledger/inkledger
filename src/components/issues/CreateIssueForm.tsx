import { readStored, writeStored } from "@/lib/storage";
import { failureText, errorText } from "@/lib/errorText";
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/lib/trpc";
import { takeCreateIssuePrefill } from "@/lib/createIssue";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { issuePath } from "@/lib/issues";

const LAST_TARGET = "ikl-create-issue-target";

/** A place a new issue can go: a container of one connection. */
type Target = { connectionId: number; container: string };

const encode = (t: Target) => JSON.stringify([t.connectionId, t.container]);

function decode(raw: string): Target | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string" ? { connectionId: v[0], container: v[1] } : null;
  } catch {
    return null;
  }
}

function lastTarget(): string {
  return readStored(LAST_TARGET) ?? "";
}

/** The new-issue form (CreateIssueDialog.tsx draws its dialog): loaded on demand. */
export function CreateIssueForm({ onClose }: { onClose: () => void }) {
  const id = useId();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const provider = useProviderName();
  const [picked, setPicked] = useState(lastTarget);
  const [typeId, setTypeId] = useState("");
  // A free post-it may open this already filled in.
  const [prefill] = useState(takeCreateIssuePrefill);
  const [summary, setSummary] = useState(prefill?.summary ?? "");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [assignToMe, setAssignToMe] = useState(true);

  // Every connection that can create, its projects or repositories (mine first).
  const targets = trpc.issues.createTargets.useQuery(undefined, { staleTime: 10 * 60_000, retry: false });
  const known = (targets.data ?? []).flatMap(c => c.containers.map(k => encode({ connectionId: c.connectionId, container: k.key })));
  const target = known.includes(picked) ? decode(picked) : null;
  const where = target ? targets.data?.find(c => c.connectionId === target.connectionId) : undefined;
  // Issue types only where the tracker asks for one (Jira).
  const types = trpc.issues.createTypes.useQuery(target ?? { connectionId: 0, container: "" }, {
    enabled: !!target && !!where?.types,
    retry: false,
    staleTime: 10 * 60_000,
  });
  // Default type: a task when there is one, else the first.
  const chosenType =
    typeId && types.data?.some(t => t.id === typeId)
      ? typeId
      : ((types.data?.find(t => /^(task|attività)$/i.test(t.name)) ?? types.data?.[0])?.id ?? "");

  const create = trpc.issues.createIn.useMutation({
    onSuccess: async ({ key, connectionId, remoteId }) => {
      toast.success(t("views.issues.create.createdIn", { key }));
      prefill?.onCreated?.(key, connectionId);
      await Promise.all([utils.issues.list.invalidate(), utils.issues.all.invalidate(), utils.issues.favorites.invalidate()]);
      onClose();
      void navigate(issuePath({ key, connectionId, remoteId: remoteId }));
    },
    onError: e => toast.error(t("views.issues.create.failed", { message: failureText(e) })),
  });

  const canSubmit = !!target && (!where?.types || !!chosenType) && summary.trim().length > 0 && !create.isPending;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !target) return;
    // Storage unavailable: the project is asked again next time.
    writeStored(LAST_TARGET, picked);
    create.mutate({
      connectionId: target.connectionId,
      container: target.container,
      title: summary.trim(),
      body: description,
      assignToMe,
      ...(where?.types ? { type: chosenType } : {}),
    });
  };
  // With one tracker its name heads nothing: the groups are "mine" and "others".
  const several = (targets.data ?? []).length > 1;

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t("views.issues.create.title")}</DialogTitle>
        <DialogDescription>{t("views.issues.create.description", { provider })}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-project`}>
              {t("views.issues.create.project")}
            </Label>
            <Select
              value={target ? picked : ""}
              onValueChange={v => {
                setPicked(v);
                setTypeId("");
              }}
            >
              <SelectTrigger id={`${id}-project`} className="w-full">
                <SelectValue
                  placeholder={targets.isPending ? t("views.issues.create.loading") : t("views.issues.create.chooseProject")}
                />
              </SelectTrigger>
              <SelectContent>
                {targets.data?.flatMap(c =>
                  ([true, false] as const)
                    .map(mine => ({ mine, list: c.containers.filter(k => k.mine === mine) }))
                    .filter(g => g.list.length > 0)
                    .map(g => (
                      <SelectGroup key={`${c.connectionId}:${g.mine}`}>
                        <SelectLabel>
                          {several ? `${c.label} · ` : ""}
                          {g.mine ? t("views.issues.create.myProjects") : t("views.issues.create.otherProjects")}
                        </SelectLabel>
                        {g.list.map(k => (
                          <SelectItem key={k.key} value={encode({ connectionId: c.connectionId, container: k.key })}>
                            {k.name && k.name !== k.key && !k.key.endsWith(`/${k.name}`) ? `${k.key} — ${k.name}` : k.key}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )),
                )}
              </SelectContent>
            </Select>
            {targets.error && (
              <p role="alert" className="text-caption text-danger">
                {errorText(targets.error)}
              </p>
            )}
          </div>
          {where?.types && (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-type`}>
                {t("views.issues.create.type")}
              </Label>
              <Select
                value={chosenType}
                onValueChange={setTypeId}
                disabled={!types.data}
              >
                <SelectTrigger id={`${id}-type`} className="w-full">
                  <SelectValue
                    placeholder={
                      types.isPending
                          ? t("views.issues.create.loading")
                          : t("views.issues.create.type")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {types.data?.map(t => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {types.error && (
                <p role="alert" className="text-caption text-danger">
                  {errorText(types.error)}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-summary`}>
            {t("views.issues.create.summary")}
          </Label>
          <Input
            id={`${id}-summary`}
            value={summary}
            onChange={e => setSummary(e.target.value)}
            maxLength={255}
            placeholder={t("views.issues.create.summaryPlaceholder")}
            autoFocus
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-description`}>
            {t("views.issues.create.descriptionLabel")}
          </Label>
          <Textarea
            id={`${id}-description`}
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={5}
            placeholder={t("views.issues.create.descriptionPlaceholder")}
          />
        </div>
        <label className="flex items-center gap-2 text-body-sm">
          <Switch checked={assignToMe} onCheckedChange={setAssignToMe} />
          {t("views.issues.create.assignToMe")}
        </label>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("views.issues.create.cancel")}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {create.isPending
            ? t("views.issues.create.creating")
            : t("views.issues.create.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
