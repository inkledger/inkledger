import { toastError, failureText } from "@/lib/errorText";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Pencil, Plus, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  addProfile,
  forgetServer,
  openProfile,
  removeProfile,
  renameProfile,
  type ServerProfile,
} from "@/lib/native";
import { currentProfileUrl, useNativeProfiles } from "@/hooks/useNativeProfiles";
import { useNativeInfo } from "@/hooks/useNativeInfo";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

const hostOf = (url: string) => url.replace(/^https?:\/\//, "");

/**
 * Native app: the servers (profiles), each with its own Jira and user —
 * add, rename, remove, open; and the way out of this one.
 */
export function ServersSection() {
  const queryClient = useQueryClient();
  const logout = trpc.auth.logout.useMutation();
  const forget = trpc.auth.forget.useMutation();
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ServerProfile | null>(null);
  const { profiles, reload } = useNativeProfiles();
  const [info] = useNativeInfo();
  const here = currentProfileUrl();
  const current = profiles?.list.find(p => p.url === here);

  const signOut = async () => {
    // Unlinked: this device must not sign in there by itself any more.
    await forget.mutateAsync().catch(() => undefined);
    // The session row goes even if this fails; the cookie is cleared by the reply.
    await logout.mutateAsync().catch(() => undefined);
    queryClient.clear();
    await forgetServer();
  };

  return (
    <>
      <SettingsGroup
        id="servers-profiles"
        title={t("settings.servers.title")}
        description={t("settings.servers.description")}
        keywords={t("settings.servers.keywords")}
        actions={
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            {t("settings.servers.add")}
          </Button>
        }
      >
        <ul className="divide-y">
          {(profiles?.list ?? []).map(p => (
            <ProfileRow
              key={p.url}
              profile={p}
              inUse={p.url === here}
              onChanged={reload}
              onRemove={() => setRemoving(p)}
            />
          ))}
        </ul>
      </SettingsGroup>

      <SettingsGroup id="servers-this" title={t("settings.servers.thisTitle")} keywords={t("settings.servers.thisKeywords")}>
        <SettingsRow label={current?.name ?? window.location.host} hint={window.location.host}>
          {info && <span className="text-caption text-muted-foreground">App {info.version}</span>}
        </SettingsRow>
        <SettingsRow
          label={t("settings.servers.signOut")}
          hint={t("settings.servers.signOutHint")}
        >
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <LogOut />
            {t("settings.servers.signOut")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <AddServerDialog open={adding} onOpenChange={setAdding} />

      <AlertDialog open={removing !== null} onOpenChange={o => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.servers.removeTitle", { name: removing?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.servers.removeBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (!removing) return;
                void removeProfile(removing.url)
                  .then(reload)
                  .catch((e: unknown) => toastError(e));
              }}
            >
              {t("common.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.servers.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.servers.confirmBody", { name: current?.name ?? window.location.host })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void signOut()}>{t("settings.servers.signOut")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProfileRow({
  profile: p,
  inUse,
  onChanged,
  onRemove,
}: {
  profile: ServerProfile;
  inUse: boolean;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const save = async () => {
    setEditing(false);
    if (name.trim() === p.name || !name.trim()) return setName(p.name);
    await renameProfile(p.url, name).then(onChanged, (e: unknown) => toastError(e));
  };

  return (
    <li className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      <span className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            value={name}
            maxLength={60}
            aria-label={t("settings.servers.nameOf", { host: hostOf(p.url) })}
            onChange={e => setName(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={e => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setName(p.name);
                setEditing(false);
              }
            }}
            className="h-8 max-w-xs"
          />
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{p.name}</span>
            {inUse && (
              <span {...surface("chip")} className="shrink-0 rounded-full bg-primary-soft px-2 text-caption font-medium text-primary-strong">
                {t("settings.servers.inUse")}
              </span>
            )}
          </span>
        )}
        <span className="block truncate text-caption text-muted-foreground">
          {[p.user, p.jira, hostOf(p.url)].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {!inUse && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openProfile(p.url).catch((e: unknown) => toastError(e))}
          >
            {t("common.open")}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t("settings.servers.rename", { name: p.name })} title={t("settings.servers.renameShort")} onClick={() => setEditing(true)}>
          <Pencil />
        </Button>
        {!inUse && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-danger"
            aria-label={t("settings.servers.removeLabel", { name: p.name })}
            title={t("common.remove")}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        )}
      </span>
    </li>
  );
}

/** Adds a server: checked first (it must answer as inkledger), then opened. */
function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // The window switches to the new server: nothing else to do here.
      await addProfile(address.trim(), name.trim() || null);
    } catch (e) {
      setError(failureText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t("settings.servers.addTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.servers.addBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="server-name">{t("settings.servers.nameOptional")}</Label>
            <Input id="server-name" value={name} onChange={e => setName(e.target.value)} placeholder={t("settings.servers.namePlaceholder")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="server-address">{t("settings.servers.address")}</Label>
            <Input
              id="server-address"
              required
              autoComplete="url"
              spellCheck={false}
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="localhost:47823"
            />
            {error && <p className="text-caption text-danger">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !address.trim()}>
              {busy ? t("settings.servers.connecting") : t("settings.servers.addAndOpen")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
