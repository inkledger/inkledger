import { useState } from "react";
import { useSearchParams } from "react-router";
import { Download, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { GroupMapEntry, SsoKind } from "@contracts/sso";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";
import { trpc } from "@/lib/trpc";
import { toastError, failureText, errorText } from "@/lib/errorText";
import { relativeTime } from "@/lib/initials";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { Chip } from "@/components/app/Chip";
import { CopyButton } from "@/components/app/CopyButton";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { EmptyState, ErrorState } from "@/components/app/States";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

type Provider = inferRouterOutputs<AppRouter>["sso"]["list"]["providers"][number];
type Role = { id: number; name: string; scope: string };

/** The form's state: the provider as typed (the secret only when typed anew). */
type Draft = {
  kind: SsoKind;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  tenantId: string;
  samlEntryPoint: string;
  samlIdpCert: string;
  scopes: string;
  claimMap: { subject: string; username: string; email: string; name: string; groups: string };
  groupMap: GroupMapEntry[];
  jitEnabled: boolean;
  defaultRoleId: number | null;
  disabled: boolean;
};

const emptyDraft = (): Draft => ({
  kind: "oidc",
  name: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  discoveryUrl: "",
  tenantId: "",
  samlEntryPoint: "",
  samlIdpCert: "",
  scopes: "openid email profile",
  claimMap: { subject: "", username: "", email: "", name: "", groups: "" },
  groupMap: [],
  jitEnabled: false,
  defaultRoleId: null,
  disabled: false,
});

const draftOf = (p: Provider): Draft => ({
  kind: p.kind,
  name: p.name,
  issuer: p.issuer,
  clientId: p.clientId,
  clientSecret: "",
  discoveryUrl: p.discoveryUrl,
  tenantId: p.tenantId,
  samlEntryPoint: p.samlEntryPoint,
  samlIdpCert: p.samlIdpCert,
  scopes: p.scopes,
  claimMap: { subject: p.claimMap.subject ?? "", username: p.claimMap.username ?? "", email: p.claimMap.email ?? "", name: p.claimMap.name ?? "", groups: p.claimMap.groups ?? "" },
  groupMap: p.groupMap,
  jitEnabled: p.jitEnabled,
  defaultRoleId: p.defaultAccess.roleId ?? null,
  disabled: p.disabled,
});

/** What the server takes: empty claim names left out, the secret only when typed. */
function inputOf(d: Draft, editing: boolean) {
  const claimMap = Object.fromEntries(Object.entries(d.claimMap).filter(([, v]) => v.trim() !== ""));
  return {
    kind: d.kind,
    name: d.name.trim(),
    issuer: d.issuer.trim(),
    clientId: d.clientId.trim(),
    ...(d.clientSecret || !editing ? { clientSecret: d.clientSecret } : {}),
    discoveryUrl: d.discoveryUrl.trim(),
    tenantId: d.tenantId.trim(),
    samlEntryPoint: d.samlEntryPoint.trim(),
    samlIdpCert: d.samlIdpCert,
    scopes: d.scopes.trim(),
    claimMap,
    groupMap: d.groupMap.filter(g => g.group.trim() !== ""),
    jitEnabled: d.jitEnabled,
    defaultAccess: { roleId: d.defaultRoleId, permissions: [], teamIds: [] },
    disabled: d.disabled,
  };
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RoleSelect({ id, value, roles, onChange, label }: { id?: string; value: number | null; roles: Role[]; onChange: (v: number | null) => void; label: string }) {
  return (
    <Select value={value === null ? "none" : String(value)} onValueChange={v => onChange(v === "none" ? null : Number(v))}>
      <SelectTrigger id={id} aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t("settings.sso.noRole")}</SelectItem>
        {roles.map(r => (
          <SelectItem key={r.id} value={String(r.id)}>
            {r.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A provider, typed: new or edited. */
function ProviderDialog({ provider, roles, onClose }: { provider: Provider | null; roles: Role[]; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [d, setD] = useState<Draft>(() => (provider ? draftOf(provider) : emptyDraft()));
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    void utils.sso.list.invalidate();
    toast.success(t("settings.sso.saved"));
    onClose();
  };
  const create = trpc.sso.createProvider.useMutation({ onSuccess: done, onError: e => setError(failureText(e)) });
  const update = trpc.sso.updateProvider.useMutation({ onSuccess: done, onError: e => setError(failureText(e)) });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(prev => ({ ...prev, [k]: v }));
  const claim = (k: keyof Draft["claimMap"], v: string) => setD(prev => ({ ...prev, claimMap: { ...prev.claimMap, [k]: v } }));
  const setGroup = (i: number, g: GroupMapEntry) => setD(prev => ({ ...prev, groupMap: prev.groupMap.map((x, j) => (j === i ? g : x)) }));
  const pending = create.isPending || update.isPending;
  const oidc = d.kind === "oidc";

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{provider ? provider.name : t("settings.sso.add")}</DialogTitle>
          <DialogDescription>{t("settings.sso.hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            setError(null);
            const input = inputOf(d, provider !== null);
            if (provider) update.mutate({ id: provider.id, ...input });
            else create.mutate(input);
          }}
        >
          {!provider && (
            <SegmentedControl<SsoKind>
              label={t("settings.sso.kind")}
              value={d.kind}
              onChange={v => set("kind", v)}
              options={[
                { value: "oidc", label: t("settings.sso.oidc") },
                { value: "saml", label: t("settings.sso.saml") },
              ]}
            />
          )}
          <Field id="sso-name" label={t("settings.sso.name")}>
            <Input id="sso-name" value={d.name} maxLength={80} onChange={e => set("name", e.target.value)} required />
          </Field>
          <Field id="sso-issuer" label={oidc ? t("settings.sso.issuer") : t("settings.sso.issuerSaml")}>
            <Input id="sso-issuer" value={d.issuer} onChange={e => set("issuer", e.target.value)} required={oidc} autoCapitalize="none" />
          </Field>
          {oidc ? (
            <>
              <Field id="sso-client" label={t("settings.sso.clientId")}>
                <Input id="sso-client" value={d.clientId} onChange={e => set("clientId", e.target.value)} required autoCapitalize="none" />
              </Field>
              <Field id="sso-secret" label={t("settings.sso.clientSecret")} hint={provider?.hasSecret ? t("settings.sso.clientSecretKept") : undefined}>
                <Input id="sso-secret" type="password" value={d.clientSecret} onChange={e => set("clientSecret", e.target.value)} autoComplete="off" />
              </Field>
              <Field id="sso-discovery" label={t("settings.sso.discoveryUrl")}>
                <Input id="sso-discovery" type="url" value={d.discoveryUrl} onChange={e => set("discoveryUrl", e.target.value)} />
              </Field>
              <Field id="sso-tenant" label={t("settings.sso.tenantId")}>
                <Input id="sso-tenant" value={d.tenantId} onChange={e => set("tenantId", e.target.value)} autoCapitalize="none" />
              </Field>
              <Field id="sso-scopes" label={t("settings.sso.scopes")}>
                <Input id="sso-scopes" value={d.scopes} onChange={e => set("scopes", e.target.value)} autoCapitalize="none" />
              </Field>
            </>
          ) : (
            <>
              <Field id="sso-entry" label={t("settings.sso.entryPoint")}>
                <Input id="sso-entry" type="url" value={d.samlEntryPoint} onChange={e => set("samlEntryPoint", e.target.value)} required />
              </Field>
              <Field id="sso-cert" label={t("settings.sso.idpCert")}>
                <Textarea id="sso-cert" rows={4} value={d.samlIdpCert} onChange={e => set("samlIdpCert", e.target.value)} required />
              </Field>
            </>
          )}
          <fieldset className="grid gap-3 border-t pt-4">
            <legend className="mb-1 text-overline uppercase text-muted-foreground">{t("settings.sso.claims")}</legend>
            <p className="text-caption text-muted-foreground">{t("settings.sso.claimsHint")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["subject", t("settings.sso.claimSubject")],
                  ["username", t("settings.sso.claimUsername")],
                  ["email", t("settings.sso.claimEmail")],
                  ["name", t("settings.sso.claimName")],
                  ["groups", t("settings.sso.claimGroups")],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} id={`sso-claim-${k}`} label={label}>
                  <Input id={`sso-claim-${k}`} value={d.claimMap[k]} onChange={e => claim(k, e.target.value)} autoCapitalize="none" />
                </Field>
              ))}
            </div>
          </fieldset>
          <fieldset className="grid gap-3 border-t pt-4">
            <legend className="mb-1 text-overline uppercase text-muted-foreground">{t("settings.sso.groupMap")}</legend>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="sso-jit">{t("settings.sso.jit")}</Label>
                <p className="text-caption text-muted-foreground">{t("settings.sso.jitHint")}</p>
              </div>
              <Switch id="sso-jit" checked={d.jitEnabled} onCheckedChange={v => set("jitEnabled", v)} />
            </div>
            <Field id="sso-default-role" label={t("settings.sso.defaultRole")}>
              <RoleSelect id="sso-default-role" label={t("settings.sso.defaultRole")} value={d.defaultRoleId} roles={roles.filter(r => r.scope === "server")} onChange={v => set("defaultRoleId", v)} />
            </Field>
            <p className="text-caption text-muted-foreground">{t("settings.sso.groupMapHint")}</p>
            <ul className="grid gap-2">
              {d.groupMap.map((g, i) => (
                <li key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
                  <Input aria-label={t("settings.sso.group")} placeholder={t("settings.sso.group")} value={g.group} onChange={e => setGroup(i, { ...g, group: e.target.value })} />
                  <RoleSelect label={t("settings.sso.role")} value={g.roleId ?? null} roles={roles.filter(r => r.scope === "server")} onChange={v => setGroup(i, { ...g, roleId: v })} />
                  <Button type="button" variant="ghost" size="icon" aria-label={t("settings.sso.removeGroup", { group: g.group })} onClick={() => set("groupMap", d.groupMap.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => set("groupMap", [...d.groupMap, { group: "", roleId: null, permissions: [], teamIds: [] }])}>
              <Plus />
              {t("settings.sso.addGroup")}
            </Button>
          </fieldset>
          {provider && (
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <Label htmlFor="sso-disabled">{t("settings.sso.disabled")}</Label>
              <Switch id="sso-disabled" checked={d.disabled} onCheckedChange={v => set("disabled", v)} />
            </div>
          )}
          <FormError message={error} />
          <Button type="submit" disabled={pending}>
            {t("settings.sso.save")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The admin's last test sign-in, after the provider sent the browser back here. */
function TestResult({ providerId }: { providerId: number }) {
  const result = trpc.sso.testResult.useQuery();
  const r = result.data;
  if (!r || r.providerId !== providerId) return null;
  if (!r.ok) {
    return (
      <p role="status" className="text-body-sm text-danger">
        {t("settings.sso.testFailed", { reason: r.failure ? t(`pages.login.ssoFailed.${r.failure}`) : "" })}
      </p>
    );
  }
  const access = r.access?.owner ? t("settings.sso.accessOwner") : r.access?.roleId != null || (r.access?.permissions.length ?? 0) > 0 ? [r.access?.roleId != null ? `#${r.access.roleId}` : null, ...(r.access?.permissions ?? [])].filter(Boolean).join(", ") : t("settings.sso.accessNone");
  return (
    <div role="status" className="grid gap-1 text-body-sm">
      <p className="text-success">{t("settings.sso.testOk", { name: r.identity?.name || r.identity?.username || "", subject: r.identity?.subject ?? "" })}</p>
      <p className="text-muted-foreground">{t("settings.sso.testAccess", { access })}</p>
      <p className="text-muted-foreground">{r.linked ? t("settings.sso.testLinked") : t("settings.sso.testNew")}</p>
    </div>
  );
}

/**
 * Settings → Single sign-on: identity providers (OIDC, SAML), test sign-in, this server's
 * addresses and SAML metadata for the provider's set-up, SCIM tokens, enforcement.
 */
export function SsoSection() {
  const utils = trpc.useUtils();
  const list = trpc.sso.list.useQuery();
  const roles = trpc.roles.list.useQuery(undefined, { staleTime: 60_000 });
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 }).data;
  const [params] = useSearchParams();
  const tested = Number(params.get("tested") ?? 0);
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [token, setToken] = useState<{ name: string; value: string } | null>(null);
  const refresh = () => void utils.sso.list.invalidate();
  const remove = trpc.sso.removeProvider.useMutation({
    onSuccess: () => {
      refresh();
      toast.success(t("settings.sso.removed"));
    },
    onError: e => toastError(e),
  });
  const setEnforced = trpc.sso.setEnforced.useMutation({ onSuccess: refresh, onError: e => toastError(e) });
  const createToken = trpc.sso.createScimToken.useMutation({ onError: e => toastError(e) });
  const revoke = trpc.sso.revokeScimToken.useMutation({
    onSuccess: () => {
      refresh();
      toast.success(t("settings.sso.revoked"));
    },
    onError: e => toastError(e),
  });
  const breakGlassMe = trpc.users.setBreakGlass.useMutation({ onSuccess: refresh, onError: e => toastError(e) });

  if (list.isPending) return <Skeleton className="m-6 h-48" />;
  if (list.error) return <ErrorState message={errorText(list.error)} onRetry={() => list.refetch()} />;
  const { providers, publicUrl, scimBase, breakGlassOwners } = list.data;
  const roleList: Role[] = roles.data ?? [];
  // "Last used" as of when the list was read.
  const now = list.dataUpdatedAt;

  return (
    <>
      <SettingsGroup
        id="sso-providers"
        title={t("settings.sso.title")}
        description={t("settings.sso.hint")}
        keywords={t("settings.sso.keywords")}
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus />
            {t("settings.sso.add")}
          </Button>
        }
      >
        {!publicUrl && <p className="mb-3 text-body-sm text-warning">{t("settings.sso.publicUrlMissing")}</p>}
        {providers.length === 0 ? (
          <EmptyState title={t("settings.sso.title")} message={t("settings.sso.empty")} />
        ) : (
          <ul className="divide-y">
            {providers.map(p => (
              <li key={p.id} className="grid gap-3 py-3 first:pt-0">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-body-sm font-medium">
                      <span className="min-w-0 truncate">{p.name}</span>
                      <Chip variant="soft" tone="neutral">
                        {p.kind === "saml" ? t("settings.sso.saml") : t("settings.sso.oidc")}
                      </Chip>
                      {p.enforced && (
                        <Chip variant="dot" tone="info">
                          {t("settings.sso.enforced")}
                        </Chip>
                      )}
                      {p.disabled && (
                        <Chip variant="dot" tone="neutral">
                          {t("settings.sso.disabled")}
                        </Chip>
                      )}
                    </p>
                    <p className="truncate text-caption text-muted-foreground">{[p.issuer, t("settings.sso.linked", { count: p.linked })].filter(Boolean).join(" · ")}</p>
                  </div>
                  <Button variant="outline" size="sm" asChild disabled={p.disabled}>
                    <a href={`/api/sso/${p.id}/start?test=1`} title={t("settings.sso.testHint")}>
                      {t("settings.sso.test")}
                    </a>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={p.name}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(p)}>{t("settings.sso.edit")}</DropdownMenuItem>
                      {p.kind === "saml" && publicUrl && (
                        <DropdownMenuItem asChild>
                          <a href={`/api/sso/${p.id}/metadata`} download>
                            <Download />
                            {t("settings.sso.metadata")}
                          </a>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setRemoving(p)}>{t("settings.sso.remove")}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {tested === p.id && <TestResult providerId={p.id} />}
                {p.urls && (
                  <dl className="grid gap-1 text-caption">
                    {(p.kind === "oidc"
                      ? ([[t("settings.sso.redirectUri"), p.urls.redirectUri]] as const)
                      : ([
                          [t("settings.sso.acsUrl"), p.urls.acs],
                          [t("settings.sso.entityId"), p.urls.entityId],
                        ] as const)
                    ).map(([label, value]) => (
                      <div key={label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                        <div className="min-w-0">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="[overflow-wrap:anywhere]">{value}</dd>
                        </div>
                        <CopyButton text={value} />
                      </div>
                    ))}
                  </dl>
                )}
                <div className="grid gap-2 border-t pt-3">
                  <p className="text-body-sm font-medium">{t("settings.sso.enforceTitle")}</p>
                  <p className="text-caption text-muted-foreground">{t("settings.sso.enforceHint")}</p>
                  <p className="text-caption text-muted-foreground">{breakGlassOwners > 0 ? t("settings.sso.breakGlassCount", { count: breakGlassOwners }) : t("settings.sso.breakGlassNone")}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant={p.enforced ? "outline" : "default"} size="sm" disabled={p.disabled || setEnforced.isPending || (!p.enforced && breakGlassOwners === 0)} onClick={() => setEnforced.mutate({ id: p.id, enforced: !p.enforced })}>
                      {p.enforced ? t("settings.sso.stopEnforcing") : t("settings.sso.enforce")}
                    </Button>
                    {breakGlassOwners === 0 && me && (
                      <Button variant="outline" size="sm" disabled={breakGlassMe.isPending} onClick={() => breakGlassMe.mutate({ id: me.id, breakGlass: true })}>
                        {t("settings.sso.breakGlassMe")}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="grid gap-2 border-t pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-body-sm font-medium">{t("settings.sso.scimTitle")}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={createToken.isPending}
                      onClick={() =>
                        createToken.mutate(
                          { providerId: p.id, label: p.name },
                          {
                            onSuccess: r => {
                              refresh();
                              setToken({ name: p.name, value: r.token });
                            },
                          },
                        )
                      }
                    >
                      <Plus />
                      {t("settings.sso.newToken")}
                    </Button>
                  </div>
                  <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{scimBase ? t("settings.sso.scimHint", { url: scimBase }) : t("settings.sso.scimNoUrl")}</p>
                  {p.scimTokens.length === 0 ? (
                    <p className="text-caption text-muted-foreground">{t("settings.sso.noTokens")}</p>
                  ) : (
                    <ul className="grid gap-1">
                      {p.scimTokens.map(tk => (
                        <li key={tk.id} className="flex min-h-target items-center gap-2 text-body-sm">
                          <span className="min-w-0 flex-1 truncate">
                            {tk.label || `#${tk.id}`}
                            <span className="ml-2 text-caption text-muted-foreground">{tk.lastUsedAt ? t("settings.sso.tokenUsed", { when: relativeTime(new Date(tk.lastUsedAt), now) }) : t("settings.sso.tokenNever")}</span>
                          </span>
                          <Button variant="ghost" size="sm" onClick={() => revoke.mutate({ id: tk.id })}>
                            {t("settings.sso.revoke")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      {editing && <ProviderDialog key={editing === "new" ? "new" : editing.id} provider={editing === "new" ? null : editing} roles={roleList} onClose={() => setEditing(null)} />}

      <Dialog open={token !== null} onOpenChange={o => !o && setToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.sso.tokenTitle", { name: token?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("settings.sso.tokenShown")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <Input readOnly value={token?.value ?? ""} aria-label={t("settings.sso.tokenTitle", { name: token?.name ?? "" })} onFocus={e => e.currentTarget.select()} />
            <CopyButton text={token?.value ?? ""} />
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={o => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.sso.removeTitle", { name: removing?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.sso.removeHint")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => removing && remove.mutate({ id: removing.id })}>{t("settings.sso.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
