import { useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { isAgentCommand, isRepoPath } from "@contracts/analyze";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { ErrorState, PageSpinner } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { errorText, toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

type Repo = { label: string; path: string };

/**
 * Where each project's code is on this computer, and the coding agent to start:
 * what "Analyse" on an issue puts in the command it copies (contracts/analyze.ts).
 * Nothing here is read or run by the app.
 */
export function RepositoriesSection() {
  const projects = trpc.projectPaths.list.useQuery();
  return (
    <>
      <AgentCommand />
      <SettingsGroup id="repositories" title={t("settings.repositories.title")} description={t("settings.repositories.description")} keywords={t("settings.categories.repositories.keywords")}>
        {projects.error ? (
          <ErrorState message={errorText(projects.error)} onRetry={() => void projects.refetch()} />
        ) : !projects.data ? (
          <PageSpinner />
        ) : projects.data.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t("settings.repositories.noProjects")}</p>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] divide-y">
            {projects.data.map(p => (
              <li key={p.id} className="py-3 first:pt-0 last:pb-0">
                <ProjectRepos id={p.id} name={`${p.key} · ${p.name}`} saved={p.paths} />
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>
    </>
  );
}

function AgentCommand() {
  const { data, persist } = useSettingsForm();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? data?.agentCommand ?? "claude";
  const valid = isAgentCommand(value);
  return (
    <SettingsGroup id="agent-command" title={t("settings.repositories.agentTitle")} description={t("settings.repositories.agentDescription")}>
      <SettingsRow label={t("settings.repositories.command")} htmlFor="agent-command" hint={valid ? t("settings.repositories.commandHint") : <span className="text-danger">{t("server.projectPaths.badCommand")}</span>}>
        <Input
          id="agent-command"
          value={value}
          maxLength={200}
          className="w-full sm:w-72"
          aria-invalid={!valid}
          onChange={e => setDraft(e.currentTarget.value)}
          onBlur={() => {
            if (draft !== null && valid && draft.trim() !== data?.agentCommand) persist({ agentCommand: draft.trim() });
            setDraft(null);
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** A project's repositories: label and path per row, saved when a field is left. */
function ProjectRepos({ id, name, saved }: { id: number; name: string; saved: Repo[] }) {
  const base = useId();
  const utils = trpc.useUtils();
  const [rows, setRows] = useState<Repo[]>(saved);
  const save = trpc.projectPaths.save.useMutation({
    onSuccess: () => void utils.projectPaths.list.invalidate(),
    onError: e => toastError(e),
  });
  const persist = (next: Repo[]) => {
    const kept = next.filter(r => r.path.trim());
    if (kept.some(r => !isRepoPath(r.path.trim()))) return;
    save.mutate({ containerId: id, paths: kept.map(r => ({ label: r.label.trim(), path: r.path.trim() })) });
  };
  const set = (i: number, patch: Partial<Repo>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid min-w-0 gap-2">
      <p className="min-w-0 truncate text-body-sm font-medium">{name}</p>
      {rows.map((r, i) => {
        const bad = r.path.trim() !== "" && !isRepoPath(r.path.trim());
        return (
          <div key={i} className="grid min-w-0 grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto] items-start gap-2 max-sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              aria-label={t("settings.repositories.label", { project: name, n: i + 1 })}
              placeholder={t("settings.repositories.labelPlaceholder")}
              value={r.label}
              maxLength={60}
              onChange={e => set(i, { label: e.currentTarget.value })}
              onBlur={() => persist(rows)}
              className="max-sm:col-span-2"
            />
            <div className="grid min-w-0 gap-1">
              <Input
                id={`${base}-${i}`}
                aria-label={t("settings.repositories.path", { project: name, n: i + 1 })}
                aria-invalid={bad}
                aria-describedby={bad ? `${base}-${i}-bad` : undefined}
                placeholder="~/code/app"
                value={r.path}
                maxLength={1000}
                onChange={e => set(i, { path: e.currentTarget.value })}
                onBlur={() => persist(rows)}
              />
              {bad && (
                <p id={`${base}-${i}-bad`} className="text-caption text-danger">
                  {t("server.projectPaths.badPath")}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.repositories.remove", { path: r.path || String(i + 1) })}
              onClick={() => {
                const next = rows.filter((_, j) => j !== i);
                setRows(next);
                persist(next);
              }}
            >
              <X />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("settings.repositories.addFor", { project: name })}
          disabled={rows.length >= 10}
          onClick={() => setRows([...rows, { label: rows.length ? "" : "app", path: "" }])}
        >
          <Plus />
          {t("settings.repositories.add")}
        </Button>
      </div>
    </div>
  );
}
