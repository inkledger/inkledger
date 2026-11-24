import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { toastError, failureText, errorText } from "@/lib/errorText";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { Chip } from "@/components/app/Chip";
import { EmptyState, ErrorState } from "@/components/app/States";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

/** A team's name, typed: for a new team or a rename. */
function NameDialog({ open, title, initial, pending, error, onClose, onSubmit }: { open: boolean; title: string; initial: string; pending: boolean; error: string | null; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("settings.teams.hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            onSubmit(name.trim());
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="team-name">{t("settings.teams.name")}</Label>
            <Input id="team-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} required />
          </div>
          <FormError message={error} />
          <Button type="submit" disabled={pending || name.trim() === ""}>
            {initial ? t("settings.teams.rename") : t("settings.teams.create")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings → Teams: groups of people and who leads them. A lead reads its team's logged
 * time, read only; making someone a lead takes holding that time yourself (the server checks).
 */
export function TeamsSection() {
  const utils = trpc.useUtils();
  const list = trpc.teams.list.useQuery();
  const refresh = () => {
    void utils.teams.list.invalidate();
    void utils.users.list.invalidate();
  };
  const [naming, setNaming] = useState<{ id: number | null; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = trpc.teams.create.useMutation({
    onSuccess: () => {
      refresh();
      setNaming(null);
      toast.success(t("settings.teams.created"));
    },
    onError: e => setError(failureText(e)),
  });
  const rename = trpc.teams.rename.useMutation({
    onSuccess: () => {
      refresh();
      setNaming(null);
      toast.success(t("settings.teams.renamed"));
    },
    onError: e => setError(failureText(e)),
  });
  const remove = trpc.teams.remove.useMutation({
    onSuccess: () => {
      refresh();
      toast.success(t("settings.teams.removed"));
    },
    onError: e => toastError(e),
  });
  const setMember = trpc.teams.setMember.useMutation({ onSuccess: refresh, onError: e => toastError(e) });
  const removeMember = trpc.teams.removeMember.useMutation({ onSuccess: refresh, onError: e => toastError(e) });

  if (list.isPending) return <Skeleton className="m-6 h-48" />;
  if (list.error) return <ErrorState message={errorText(list.error)} onRetry={() => list.refetch()} />;
  const { teams, people } = list.data;

  return (
    <SettingsGroup
      id="teams-list"
      title={t("settings.teams.title")}
      description={t("settings.teams.hint")}
      keywords={t("settings.teams.keywords")}
      actions={
        <Button
          size="sm"
          onClick={() => {
            setError(null);
            setNaming({ id: null, name: "" });
          }}
        >
          <Plus />
          {t("settings.teams.newTeam")}
        </Button>
      }
    >
      {teams.length === 0 ? (
        <EmptyState title={t("settings.teams.title")} message={t("settings.teams.empty")} />
      ) : (
        <ul className="divide-y">
          {teams.map(team => {
            const outside = people.filter(p => !team.members.some(m => m.userId === p.id));
            return (
              <li key={team.id} className="grid gap-2 py-3 first:pt-0">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-sm font-medium">{team.name}</p>
                    <p className="truncate text-caption text-muted-foreground">{t("settings.teams.count", { count: team.members.length })}</p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={t("settings.teams.actions", { name: team.name })}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setError(null);
                          setNaming({ id: team.id, name: team.name });
                        }}
                      >
                        {t("settings.teams.rename")}…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setRemoving({ id: team.id, name: team.name })}>{t("settings.teams.remove")}…</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {team.members.length === 0 ? (
                  <p className="text-caption text-muted-foreground">{t("settings.teams.emptyMembers")}</p>
                ) : (
                  <ul className="grid gap-1">
                    {team.members.map(m => (
                      <li key={m.userId} className="flex min-h-target items-center gap-2 text-body-sm">
                        <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                        {m.role === "lead" && (
                          <Chip variant="dot" tone="info">
                            {t("settings.teams.lead")}
                          </Chip>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={t("settings.teams.memberActions", { name: m.displayName, team: team.name })}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setMember.mutate({ teamId: team.id, userId: m.userId, role: m.role === "lead" ? "member" : "lead" })}>
                              {m.role === "lead" ? t("settings.teams.makeMember") : t("settings.teams.makeLead")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => removeMember.mutate({ teamId: team.id, userId: m.userId })}>{t("settings.teams.removeMember")}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    ))}
                  </ul>
                )}
                {outside.length > 0 && (
                  <Select value="" onValueChange={v => setMember.mutate({ teamId: team.id, userId: Number(v), role: "member" })}>
                    <SelectTrigger className="w-full sm:w-64" aria-label={t("settings.teams.addTo", { name: team.name })}>
                      <SelectValue placeholder={t("settings.teams.add")} />
                    </SelectTrigger>
                    <SelectContent>
                      {outside.map(p => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {naming && (
        <NameDialog
          key={naming.id ?? "new"}
          open
          title={naming.id === null ? t("settings.teams.newTeam") : t("settings.teams.rename")}
          initial={naming.name}
          pending={create.isPending || rename.isPending}
          error={error}
          onClose={() => setNaming(null)}
          onSubmit={name => (naming.id === null ? create.mutate({ name }) : rename.mutate({ id: naming.id, name }))}
        />
      )}

      <AlertDialog open={removing !== null} onOpenChange={o => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.teams.removeTitle", { name: removing?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.teams.removeHint")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.teams.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => removing && remove.mutate({ id: removing.id })}>{t("settings.teams.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}
