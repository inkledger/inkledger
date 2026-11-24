import { toastError, failureText } from "@/lib/errorText";
import { copyText } from "@/lib/issues";
import { QrCode } from "@/components/app/QrCode";
import { lazy, Suspense, useState } from "react";
import { Copy, Download, MoreHorizontal, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { INVITE_DAYS, OWNER_ONLY_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES, type Permission, type SystemRole, DEFAULT_PERMISSIONS } from "@contracts/accounts";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { Chip } from "@/components/app/Chip";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { currentLocale, t } from "@/i18n";
import { mediumDate } from "@/lib/dates";
import { loc } from "./store/format";
import { surface } from "@/components/app/surface";
import { useDirtyClose } from "@/components/app/DirtyClose";
import { RenameForm } from "@/components/settings/RenameForm";

/** Loaded only when an owner opens it. */
const EraseUser = lazy(() => import("./EraseUser"));

type Account = inferRouterOutputs<AppRouter>["users"]["list"][number];
type RoleView = inferRouterOutputs<AppRouter>["roles"]["list"][number];
type TeamView = inferRouterOutputs<AppRouter>["teams"]["list"]["teams"][number];
/** What the form edits: the role, the account's own grants beside it, its modules and teams. */
type Access = { roleId: number | null; permissions: Permission[]; modules: string[]; teams: { teamId: number; lead: boolean }[] };

const isSystemRole = (key: string): key is SystemRole => (SYSTEM_ROLES as readonly string[]).includes(key);

const SYSTEM_ROLE_LABEL: Record<SystemRole, () => string> = {
  owner: () => t("settings.users.roleName.owner"),
  "it-admin": () => t("settings.users.roleName.it-admin"),
  "team-lead": () => t("settings.users.roleName.team-lead"),
  auditor: () => t("settings.users.roleName.auditor"),
  member: () => t("settings.users.roleName.member"),
};

/** A role's name: the system ones translated, the server's own as named. */
const roleLabel = (r: { key: string; name: string; system: boolean }) => (r.system && isSystemRole(r.key) ? SYSTEM_ROLE_LABEL[r.key]() : r.name);

function roleHint(role: RoleView | undefined): string {
  if (!role) return t("settings.users.roleHint.none");
  switch (role.system ? role.key : "") {
    case "owner":
      return t("settings.users.roleHint.owner");
    case "it-admin":
      return t("settings.users.roleHint.it-admin");
    case "auditor":
      return t("settings.users.roleHint.auditor");
    case "member":
      return t("settings.users.roleHint.member");
    default:
      return t("settings.users.roleHint.custom");
  }
}

/** The add-on modules installed here, each granted on its own: none for a new account. */
function ModuleGrants({ value, onChange, admin }: { value: Access; onChange: (v: Access) => void; admin: boolean }) {
  const installed = trpc.modules.list.useQuery().data?.modules ?? [];
  if (installed.length === 0) return null;
  const set = (id: string, on: boolean) => {
    const modules = on ? [...value.modules, id] : value.modules.filter(m => m !== id);
    // A module granted brings the permission to run modules; the last one taken away, it goes too.
    const permissions = value.permissions.filter(p => p !== "useModules");
    onChange({ ...value, modules, permissions: modules.length > 0 ? [...permissions, "useModules"] : permissions });
  };
  return (
    <div className="grid gap-2 pl-6">
      <p className="text-caption text-muted-foreground">{t("settings.users.modulesHint")}</p>
      {installed.map(m => (
        <label key={m.id} className="flex items-center gap-2 text-body-sm">
          <Checkbox checked={admin || value.modules.includes(m.id)} disabled={admin} onCheckedChange={on => set(m.id, on === true)} />
          {loc(m.name, currentLocale())}
        </label>
      ))}
    </div>
  );
}

/** The teams an account is in, and where it leads (a lead reads that team's time). */
function TeamPlaces({ value, onChange, teams }: { value: Access; onChange: (v: Access) => void; teams: TeamView[] }) {
  const place = (teamId: number) => value.teams.find(p => p.teamId === teamId);
  const set = (teamId: number, next: { lead: boolean } | null) =>
    onChange({ ...value, teams: [...value.teams.filter(p => p.teamId !== teamId), ...(next ? [{ teamId, ...next }] : [])] });
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-body-sm font-medium">{t("settings.users.teams")}</legend>
      <p className="text-caption text-muted-foreground">{teams.length === 0 ? t("settings.users.noTeams") : t("settings.users.teamsHint")}</p>
      {teams.map(team => {
        const at = place(team.id);
        return (
          <div key={team.id} className="flex items-center gap-3 text-body-sm">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <Checkbox checked={Boolean(at)} onCheckedChange={on => set(team.id, on === true ? { lead: false } : null)} />
              <span className="truncate">{team.name}</span>
            </label>
            <label className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
              <Checkbox
                checked={at?.lead ?? false}
                disabled={!at}
                aria-label={`${t("settings.users.lead")}: ${team.name}`}
                onCheckedChange={on => set(team.id, { lead: on === true })}
              />
              {t("settings.users.lead")}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Role, what the account may manage besides it (an owner may manage everything), its
 * modules and its teams. Only an owner makes an owner or hands out manageUsers or
 * manageAuth (the server refuses it to anyone else).
 */
function AccessFields({ value, onChange, roles, teams }: { value: Access; onChange: (v: Access) => void; roles: RoleView[]; teams: TeamView[] | null }) {
  const byOwner = useAuth().user?.role === "admin";
  const serverRoles = roles.filter(r => r.scope === "server");
  const role = serverRoles.find(r => r.id === value.roleId);
  const owner = role?.key === "owner";
  const fromRole: readonly Permission[] = role?.permissions ?? [];
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="access-role">{t("settings.users.role")}</Label>
        <Select value={value.roleId === null ? "none" : String(value.roleId)} onValueChange={v => onChange({ ...value, roleId: v === "none" ? null : Number(v) })}>
          <SelectTrigger id="access-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("settings.users.noRole")}</SelectItem>
            {serverRoles.map(r => (
              <SelectItem key={r.id} value={String(r.id)} disabled={r.key === "owner" && !byOwner}>
                {roleLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-caption text-muted-foreground">{roleHint(role)}</p>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-body-sm font-medium">{role ? t("settings.users.ownPermissions") : t("settings.users.permissions")}</legend>
        {owner && <p className="text-caption text-muted-foreground">{t("settings.users.adminHint")}</p>}
        {PERMISSIONS.filter(p => p !== "useModules").map(p => {
          const held = owner || fromRole.includes(p);
          return (
            <label key={p} className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={held || value.permissions.includes(p)}
                disabled={held || (OWNER_ONLY_PERMISSIONS.includes(p) && !byOwner && !value.permissions.includes(p))}
                onCheckedChange={on =>
                  onChange({ ...value, permissions: on === true ? [...value.permissions, p] : value.permissions.filter(x => x !== p) })
                }
              />
              {t(`settings.users.permission.${p}`)}
            </label>
          );
        })}
        <span className="mt-1 text-body-sm">{t("settings.users.permission.useModules")}</span>
        <ModuleGrants value={value} onChange={onChange} admin={owner} />
      </fieldset>
      {teams && <TeamPlaces value={value} onChange={onChange} teams={teams} />}
    </>
  );
}

/** Something to hand over once: an invite link or a temporary password. */
function HandOver({ shown, onClose }: { shown: { title: string; hint: string; value: string; qr?: boolean } | null; onClose: () => void }) {
  const copy = (value: string) => copyText(value).then(ok => ok && toast.success(t("settings.users.copied")));
  return (
    <Dialog open={shown !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        {shown && (
          <>
            <DialogHeader>
              <DialogTitle>{shown.title}</DialogTitle>
              <DialogDescription>{shown.hint}</DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={shown.value} aria-label={shown.title} onFocus={e => e.target.select()} />
              <Button variant="outline" onClick={() => void copy(shown.value)}>
                <Copy />
                {t("settings.users.copy")}
              </Button>
            </div>
            {/* A link to open on a phone: its camera reads it (the server sends no mail). */}
            {shown.qr && (
              <span {...surface("picture")} className="mx-auto mt-2 flex w-fit rounded-lg">
                <QrCode value={shown.value} label={shown.title} className="h-44 w-44" />
              </span>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const newInvite = (): { username: string; displayName: string; access: Access } => ({ username: "", displayName: "", access: { roleId: null, permissions: [...DEFAULT_PERMISSIONS], modules: [], teams: [] } });

/** An account's own access, as the form edits it. */
const accessOf = (u: Account): Access => ({ roleId: u.roleId, permissions: u.granted, modules: u.modules, teams: u.teams.map(p => ({ teamId: p.teamId, lead: p.role === "lead" })) });

/** What an account is, in one line: its role (or its grants), and the teams it leads. */
function accessLine(u: Account, roles: RoleView[]): string {
  const role = roles.find(r => r.id === u.roleId);
  if (u.role === "admin") return t("settings.users.admin");
  const own = u.granted.map(p => t(`settings.users.permission.${p}`));
  return [role ? roleLabel(role) : null, ...own].filter(Boolean).join(", ") || t("settings.users.member");
}

const absolute = (path: string) => new URL(path, window.location.origin).toString();
const linkHint = (expiresAt: Date) => t("settings.users.linkHint", { date: mediumDate(expiresAt) });

export function UsersSection() {
  const { user: me } = useAuth();
  const utils = trpc.useUtils();
  const list = trpc.users.list.useQuery();
  const roles = trpc.roles.list.useQuery().data ?? [];
  // Teams to pick from only for whoever may manage them; the others see an account's teams as they are.
  const canTeams = (me?.permissions ?? []).includes("manageTeams");
  // A person's data on request: exported with exportUserData, erased by an owner (the server checks both).
  const canExport = (me?.permissions ?? []).includes("exportUserData");
  const canErase = me?.role === "admin" && (me.permissions ?? []).includes("eraseUserData");
  const [erasing, setErasing] = useState<Account | null>(null);
  const teams = trpc.teams.list.useQuery(undefined, { enabled: canTeams }).data?.teams ?? null;
  const refresh = () => void utils.users.list.invalidate();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [renaming, setRenaming] = useState<Account | null>(null);
  // Closing over a changed name asks first (a saved or untouched one closes at once).
  const renameGuard = useDirtyClose(() => setRenaming(null));
  const [shown, setShown] = useState<{ title: string; hint: string; value: string; qr?: boolean } | null>(null);
  const [form, setForm] = useState(newInvite);
  const [access, setAccess] = useState<Access>(newInvite().access);
  /** What a save sends: teams only when this account may manage them (left out, they stay as they are). */
  const sent = (a: Access) => ({ ...a, teams: canTeams ? a.teams : undefined });
  const [error, setError] = useState<string | null>(null);

  const invite = trpc.users.invite.useMutation({
    onSuccess: r => {
      refresh();
      setInviting(false);
      setForm(newInvite());
      setShown({ title: t("settings.users.linkTitle", { name: r.user.displayName }), hint: linkHint(r.expiresAt), value: absolute(r.link), qr: true });
    },
    onError: e => setError(failureText(e)),
  });
  const reinvite = trpc.users.reinvite.useMutation({
    onSuccess: (r, v) => {
      const who = list.data?.find(u => u.id === v.id);
      setShown({ title: t("settings.users.linkTitle", { name: who?.displayName ?? "" }), hint: linkHint(r.expiresAt), value: absolute(r.link), qr: true });
    },
    onError: e => toastError(e),
  });
  const reset = trpc.users.resetPassword.useMutation({
    onSuccess: (r, v) => {
      refresh();
      const who = list.data?.find(u => u.id === v.id);
      setShown({ title: t("settings.users.resetTitle", { name: who?.displayName ?? "" }), hint: t("settings.users.resetHint"), value: r.password });
    },
    onError: e => toastError(e),
  });
  const setDisabled = trpc.users.setDisabled.useMutation({ onSuccess: refresh, onError: e => toastError(e) });
  const rename = trpc.users.rename.useMutation({
    onSuccess: () => {
      refresh();
      setRenaming(null);
      toast.success(t("settings.users.renamed"));
    },
  });
  const saveAccess = trpc.users.setAccess.useMutation({
    onSuccess: () => {
      refresh();
      setEditing(null);
      toast.success(t("settings.users.accessSaved"));
    },
    onError: e => setError(failureText(e)),
  });

  return (
    <SettingsGroup
      id="users-accounts"
      title={t("settings.users.accounts")}
      keywords={t("settings.users.accountsKeywords")}
      actions={
        <Button size="sm" onClick={() => { setError(null); setInviting(true); }}>
          <UserPlus />
          {t("settings.users.invite")}
        </Button>
      }
    >
      <ul className="divide-y">
        {list.data?.map(u => (
          <li key={u.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-sm font-medium">
                {u.displayName}
                {u.id === me?.id && <span className="ml-2 text-caption text-muted-foreground">{t("settings.users.you")}</span>}
              </p>
              <p className="truncate text-caption text-muted-foreground">
                {[
                  u.username,
                  accessLine(u, roles),
                  u.pending && t("settings.users.pending"),
                  t("settings.users.trackers", { count: u.connections }),
                  u.disabled && t("settings.users.disabled"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {u.teams.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1">
                  {u.teams.map(p => (
                    <Chip key={p.teamId} variant={p.role === "lead" ? "dot" : "soft"} tone={p.role === "lead" ? "info" : "neutral"}>
                      {p.role === "lead" ? `${p.name} · ${t("settings.users.lead")}` : p.name}
                    </Chip>
                  ))}
                </p>
              )}
            </div>
            {u.id !== me?.id && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t("settings.users.actions", { name: u.displayName })}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      rename.reset();
                      renameGuard.markDirty(false);
                      setRenaming(u);
                    }}
                  >
                    {t("settings.users.rename")}…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setError(null);
                      setAccess(accessOf(u));
                      setEditing(u);
                    }}
                  >
                    {t("settings.users.permissions")}…
                  </DropdownMenuItem>
                  {u.pending ? (
                    <DropdownMenuItem onSelect={() => reinvite.mutate({ id: u.id })}>{t("settings.users.newLink")}</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => reset.mutate({ id: u.id })}>{t("settings.users.resetPassword")}</DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setDisabled.mutate({ id: u.id, disabled: !u.disabled })}>
                    {u.disabled ? t("settings.users.turnOn") : t("settings.users.turnOff")}
                  </DropdownMenuItem>
                  {canExport && (
                    <DropdownMenuItem asChild>
                      <a href={`/api/users/${u.id}/export`} download>
                        <Download />
                        {t("settings.users.exportData")}
                      </a>
                    </DropdownMenuItem>
                  )}
                  {canErase && (
                    <DropdownMenuItem variant="destructive" onSelect={() => setErasing(u)}>
                      <Trash2 />
                      {t("settings.users.erase")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.users.invite")}</DialogTitle>
            <DialogDescription>{t("settings.users.inviteHint", { days: INVITE_DAYS })}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={e => {
              e.preventDefault();
              setError(null);
              invite.mutate({ username: form.username, displayName: form.displayName, ...sent(form.access) });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="invite-name">{t("settings.users.displayName")}</Label>
              <Input id="invite-name" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-username">{t("settings.users.username")}</Label>
              <Input id="invite-username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoCapitalize="none" autoComplete="off" required />
            </div>
            <AccessFields value={form.access} onChange={a => setForm({ ...form, access: a })} roles={roles} teams={teams} />
            <FormError message={error} />
            <Button type="submit" disabled={invite.isPending}>
              {t("settings.users.create")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.displayName}</DialogTitle>
            <DialogDescription>{editing?.username}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={e => {
              e.preventDefault();
              if (editing) saveAccess.mutate({ id: editing.id, ...sent(access) });
            }}
          >
            <AccessFields value={access} onChange={setAccess} roles={roles} teams={teams} />
            <FormError message={error} />
            <Button type="submit" disabled={saveAccess.isPending}>
              {t("settings.users.saveAccess")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {renameGuard.confirm}
      <Dialog open={renaming !== null} onOpenChange={renameGuard.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{renaming?.displayName}</DialogTitle>
            <DialogDescription>{t("settings.users.renameHint")}</DialogDescription>
          </DialogHeader>
          {renaming && (
            <RenameForm
              key={renaming.id}
              initial={{ displayName: renaming.displayName, username: renaming.username ?? "" }}
              pending={rename.isPending}
              error={rename.error}
              onDirty={renameGuard.markDirty}
              onSubmit={v => rename.mutate({ id: renaming.id, ...v })}
            />
          )}
        </DialogContent>
      </Dialog>

      <HandOver shown={shown} onClose={() => setShown(null)} />
      {erasing && (
        <Suspense fallback={null}>
          <EraseUser
            target={erasing}
            onClose={() => setErasing(null)}
            onErased={() => {
              setErasing(null);
              refresh();
            }}
          />
        </Suspense>
      )}
    </SettingsGroup>
  );
}
