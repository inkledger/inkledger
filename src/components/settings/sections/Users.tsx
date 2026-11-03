import { toastError, failureText } from "@/lib/errorText";
import { copyText } from "@/lib/issues";
import { QrCode } from "@/components/app/QrCode";
import { useState } from "react";
import { Copy, MoreHorizontal, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { INVITE_DAYS, PERMISSIONS, type Permission, type Role, DEFAULT_PERMISSIONS } from "@contracts/accounts";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dateFormat, getLocale, t } from "@/i18n";
import { loc } from "./store/format";
import { surface } from "@/components/app/surface";
import { useDirtyClose } from "@/components/app/DirtyClose";
import { RenameForm } from "@/components/settings/RenameForm";

type Account = inferRouterOutputs<AppRouter>["users"]["list"][number];
type Access = { role: Role; permissions: Permission[]; modules: string[] };

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
          {loc(m.name, getLocale())}
        </label>
      ))}
    </div>
  );
}

/** Role, what a member may manage (an admin may manage everything), and the modules it runs. */
function AccessFields({ value, onChange }: { value: Access; onChange: (v: Access) => void }) {
  const admin = value.role === "admin";
  return (
    <>
      <SegmentedControl
        label={t("settings.users.role")}
        value={value.role}
        onChange={role => onChange({ ...value, role })}
        className="w-full [&>button]:flex-1 [&>button]:justify-center"
        options={[
          { value: "member", label: t("settings.users.member") },
          { value: "admin", label: t("settings.users.admin") },
        ]}
      />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-body-sm font-medium">{t("settings.users.permissions")}</legend>
        {admin && <p className="text-caption text-muted-foreground">{t("settings.users.adminHint")}</p>}
        {PERMISSIONS.filter(p => p !== "useModules").map(p => (
          <label key={p} className="flex items-center gap-2 text-body-sm">
            <Checkbox
              checked={admin || value.permissions.includes(p)}
              disabled={admin}
              onCheckedChange={on =>
                onChange({ ...value, permissions: on === true ? [...value.permissions, p] : value.permissions.filter(x => x !== p) })
              }
            />
            {t(`settings.users.permission.${p}`)}
          </label>
        ))}
        <span className="mt-1 text-body-sm">{t("settings.users.permission.useModules")}</span>
        <ModuleGrants value={value} onChange={onChange} admin={admin} />
      </fieldset>
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

const newInvite = (): { username: string; displayName: string; access: Access } => ({ username: "", displayName: "", access: { role: "member", permissions: [...DEFAULT_PERMISSIONS], modules: [] } });

const absolute = (path: string) => new URL(path, window.location.origin).toString();
const linkHint = (expiresAt: Date) => t("settings.users.linkHint", { date: dateFormat({ dateStyle: "medium" }).format(expiresAt) });

export function UsersSection() {
  const { user: me } = useAuth();
  const utils = trpc.useUtils();
  const list = trpc.users.list.useQuery();
  const refresh = () => void utils.users.list.invalidate();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [renaming, setRenaming] = useState<Account | null>(null);
  // Closing over a changed name asks first (a saved or untouched one closes at once).
  const renameGuard = useDirtyClose(() => setRenaming(null));
  const [shown, setShown] = useState<{ title: string; hint: string; value: string; qr?: boolean } | null>(null);
  const [form, setForm] = useState(newInvite);
  const [access, setAccess] = useState<Access>({ role: "member", permissions: [], modules: [] });
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
                  u.role === "admin" ? t("settings.users.admin") : u.permissions.map(p => t(`settings.users.permission.${p}`)).join(", ") || t("settings.users.member"),
                  u.pending && t("settings.users.pending"),
                  t("settings.users.trackers", { count: u.connections }),
                  u.disabled && t("settings.users.disabled"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
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
                      setAccess({ role: u.role, permissions: u.permissions, modules: u.modules });
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
              invite.mutate({ username: form.username, displayName: form.displayName, ...form.access });
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
            <AccessFields value={form.access} onChange={a => setForm({ ...form, access: a })} />
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
              if (editing) saveAccess.mutate({ id: editing.id, ...access });
            }}
          >
            <AccessFields value={access} onChange={setAccess} />
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
    </SettingsGroup>
  );
}
