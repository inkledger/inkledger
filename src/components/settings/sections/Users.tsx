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
import { dateFormat, t } from "@/i18n";

type Account = inferRouterOutputs<AppRouter>["users"]["list"][number];
type Access = { role: Role; permissions: Permission[] };

/** Role, and what a member may manage (an admin may manage everything). */
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
        {PERMISSIONS.map(p => (
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
      </fieldset>
    </>
  );
}

/** Something to hand over once: an invite link or a temporary password. */
function HandOver({ shown, onClose }: { shown: { title: string; hint: string; value: string; qr?: boolean } | null; onClose: () => void }) {
  const copy = (value: string) =>
    navigator.clipboard.writeText(value).then(
      () => toast.success(t("settings.users.copied")),
      () => undefined,
    );
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
            {shown.qr && <QrCode value={shown.value} label={shown.title} className="mx-auto mt-2 h-44 w-44" />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const newInvite = (): { username: string; displayName: string; access: Access } => ({ username: "", displayName: "", access: { role: "member", permissions: [...DEFAULT_PERMISSIONS] } });

const absolute = (path: string) => new URL(path, window.location.origin).toString();
const linkHint = (expiresAt: Date) => t("settings.users.linkHint", { date: dateFormat({ dateStyle: "medium" }).format(expiresAt) });

export function UsersSection() {
  const { user: me } = useAuth();
  const utils = trpc.useUtils();
  const list = trpc.users.list.useQuery();
  const refresh = () => void utils.users.list.invalidate();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [shown, setShown] = useState<{ title: string; hint: string; value: string; qr?: boolean } | null>(null);
  const [form, setForm] = useState(newInvite);
  const [access, setAccess] = useState<Access>({ role: "member", permissions: [] });
  const [error, setError] = useState<string | null>(null);

  const invite = trpc.users.invite.useMutation({
    onSuccess: r => {
      refresh();
      setInviting(false);
      setForm(newInvite());
      setShown({ title: t("settings.users.linkTitle", { name: r.user.displayName }), hint: linkHint(r.expiresAt), value: absolute(r.link), qr: true });
    },
    onError: e => setError(e.message),
  });
  const reinvite = trpc.users.reinvite.useMutation({
    onSuccess: (r, v) => {
      const who = list.data?.find(u => u.id === v.id);
      setShown({ title: t("settings.users.linkTitle", { name: who?.displayName ?? "" }), hint: linkHint(r.expiresAt), value: absolute(r.link), qr: true });
    },
    onError: e => toast.error(e.message),
  });
  const reset = trpc.users.resetPassword.useMutation({
    onSuccess: (r, v) => {
      refresh();
      const who = list.data?.find(u => u.id === v.id);
      setShown({ title: t("settings.users.resetTitle", { name: who?.displayName ?? "" }), hint: t("settings.users.resetHint"), value: r.password });
    },
    onError: e => toast.error(e.message),
  });
  const setDisabled = trpc.users.setDisabled.useMutation({ onSuccess: refresh, onError: e => toast.error(e.message) });
  const saveAccess = trpc.users.setAccess.useMutation({
    onSuccess: () => {
      refresh();
      setEditing(null);
      toast.success(t("settings.users.accessSaved"));
    },
    onError: e => setError(e.message),
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
                      setError(null);
                      setAccess({ role: u.role, permissions: u.permissions });
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

      <HandOver shown={shown} onClose={() => setShown(null)} />
    </SettingsGroup>
  );
}
