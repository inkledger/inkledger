import { errorText, toastError } from "@/lib/errorText";
import { toast } from "sonner";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { trpc } from "@/lib/trpc";
import { formatDuration } from "@contracts/time";
import { AGENT_LINK_MINUTES } from "@contracts/issueCopy";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { useState } from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import { useAllowedLinks } from "@/hooks/useAllowedLinks";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";

/** Settings → External links: the domains whose links open without asking. */
export function LinksSection() {
  const { domains, trackers, allow, remove, loading, error: loadError, refetch } = useAllowedLinks();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () =>
    void allow(draft).then(
      () => {
        setDraft("");
        setError(null);
      },
      () => setError(t("settings.links.invalid"))
    );

  if (loading) return <Skeleton className="m-6 h-40" />;
  if (loadError) return <ErrorState message={errorText(loadError)} onRetry={() => void refetch()} />;
  return (
    <>
    <SettingsGroup
      id="links-allowed"
      title={t("settings.links.title")}
      description={t("settings.links.description")}
      keywords={t("settings.links.keywords")}
    >
      <form
        onSubmit={e => {
          e.preventDefault();
          add();
        }}
        className="flex max-w-md gap-2"
      >
        <Input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={t("settings.links.placeholder")}
          aria-label={t("settings.links.label")}
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" variant="outline" disabled={!draft.trim()}>
          <Plus />
          {t("settings.links.allow")}
        </Button>
      </form>
      {error && <p className="mt-1 text-caption text-danger">{error}</p>}

      <ul className="mt-4 divide-y">
        {trackers.map(s => (
          <li key={s.host} className="flex items-center gap-3 py-2">
            <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="flex-1 truncate font-medium">{s.host}</span>
            <span className="text-caption text-muted-foreground">{t("settings.links.yourJira", { provider: s.name })}</span>
          </li>
        ))}
        {domains.map(d => (
          <li key={d} className="flex items-center gap-3 py-2">
            <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="flex-1 truncate font-medium">{d}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-danger"
              aria-label={t("settings.links.remove", { domain: d })}
              title={t("common.remove")}
              onClick={() => remove(d)}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      {domains.length === 0 && (
        <p className="mt-2 text-body-sm text-muted-foreground">
          {t("settings.links.empty")}
        </p>
      )}
    </SettingsGroup>
    <AgentLinks />
    </>
  );
}

/** Links copied for an agent (docs/work/ideas/issue-copy.md R-6.4, R-6.5): their default life, and revoking them all. */
function AgentLinks() {
  const { query, data, persist } = useSettingsForm();
  const [confirming, setConfirming] = useState(false);
  const revoke = trpc.settings.revokeShareLinks.useMutation({
    onSuccess: () => toast.success(t("settings.links.agent.revoked")),
    onError: e => toastError(e),
  });
  return (
    <SettingsGroup id="links-agent" title={t("settings.links.agent.title")} description={t("settings.links.agent.body")} keywords={t("settings.links.agent.keywords")}>
      {query.error ? (
        <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <Skeleton className="h-16" />
      ) : (
        <div className="grid gap-4">
          <SettingsRow label={t("settings.links.agent.duration")} htmlFor="agent-link-minutes">
            <Select value={String(data.shareLinkMinutes)} onValueChange={v => persist({ shareLinkMinutes: Number(v) })}>
              <SelectTrigger id="agent-link-minutes" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_LINK_MINUTES.map(m => (
                  <SelectItem key={m} value={String(m)}>
                    {formatDuration(m * 60)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <div>
            <Button variant="outline" disabled={revoke.isPending} onClick={() => setConfirming(true)}>
              {t("settings.links.agent.revoke")}
            </Button>
          </div>
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.links.agent.revoke")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.links.agent.revokeConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => revoke.mutate()}>
              {t("settings.links.agent.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}
