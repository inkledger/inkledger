import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { providerName } from "@contracts/providerNames";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { MoreHorizontal, Plug, Plus } from "lucide-react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";
import { trpc } from "@/lib/trpc";
import { relevanceText } from "@/lib/issues";
import { emptyJiraLogin, jiraLoginPayload } from "@/lib/jiraLogin";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { JiraLoginFields } from "@/components/auth/JiraLoginFields";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

type Shown = inferRouterOutputs<AppRouter>["connections"]["list"][number];

/** Every connection change: lists, banner and issues follow. */
function useRefresh() {
  const utils = trpc.useUtils();
  return () => void utils.invalidate();
}

/** A Jira login, for a new connection or new credentials of one. */
function JiraForm({ reconnect, onDone }: { reconnect?: Shown; onDone: () => void }) {
  const refresh = useRefresh();
  const [value, setValue] = useState(() => ({ ...emptyJiraLogin(), ...(reconnect ? { siteUrl: `https://${reconnect.host}` } : {}) }));
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = (msg: string) => {
    toast.success(msg);
    refresh();
    onDone();
  };
  const add = trpc.connections.addJira.useMutation({ onSuccess: c => done(t("settings.connections.added", { name: c.label || c.host })), onError: e => setError(e.message) });
  const again = trpc.connections.reconnectJira.useMutation({ onSuccess: () => done(t("settings.connections.reconnected")), onError: e => setError(e.message) });
  const pending = add.isPending || again.isPending;
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        setError(null);
        if (reconnect) again.mutate({ id: reconnect.id, ...jiraLoginPayload(value) });
        else add.mutate({ ...jiraLoginPayload(value), label });
      }}
    >
      <JiraLoginFields value={value} onChange={setValue} idPrefix={reconnect ? "reconnect-jira" : "add-jira"} />
      {!reconnect && (
        <div className="grid gap-2">
          <Label htmlFor="add-jira-label">{t("settings.connections.label")}</Label>
          <Input id="add-jira-label" value={label} onChange={e => setLabel(e.target.value)} placeholder={t("settings.connections.labelPlaceholder")} />
        </div>
      )}
      <FormError message={error} />
      <Button type="submit" disabled={pending}>
        {pending ? t("pages.login.verifying") : reconnect ? t("settings.connections.reconnect") : t("settings.connections.connect")}
      </Button>
    </form>
  );
}

/** Signing in on GitHub: a code to enter there, then inkledger waits for the authorization. */
function GitHubForm({ onDone }: { onDone: () => void }) {
  const refresh = useRefresh();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<{ flowId: string; userCode: string; verificationUri: string; intervalSeconds: number } | null>(null);
  const poll = trpc.connections.githubPoll.useMutation();
  const start = trpc.connections.githubStart.useMutation({
    onSuccess: f => {
      setFlow(f);
      window.open(f.verificationUri, "_blank", "noopener");
    },
    onError: e => setError(e.message),
  });
  const { mutateAsync } = poll;
  // The latest callbacks, without restarting the wait at each render.
  const finish = useRef(() => {});
  useEffect(() => {
    finish.current = () => {
      refresh();
      onDone();
    };
  });
  useEffect(() => {
    if (!flow) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = (seconds: number) => {
      timer = setTimeout(() => {
        void mutateAsync({ flowId: flow.flowId })
          .then(r => {
            if (stopped) return;
            if (r.state === "pending") return ask(r.retryInSeconds);
            if (r.state === "done") {
              toast.success(t("settings.connections.added", { name: r.connection.label || r.connection.displayName || "GitHub" }));
              finish.current();
              return;
            }
            setFlow(null);
            setError(r.reason === "denied" ? t("settings.connections.githubDenied") : t("settings.connections.githubExpired"));
          })
          .catch((e: unknown) => {
            if (stopped) return;
            setFlow(null);
            setError(e instanceof Error ? e.message : String(e));
          });
      }, seconds * 1000);
    };
    ask(flow.intervalSeconds);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [flow, mutateAsync]);

  if (flow) {
    return (
      <div className="grid gap-4">
        <div className="grid gap-1 text-center">
          <p className="text-body-sm text-muted-foreground">{t("settings.connections.githubCode")}</p>
          <p className="text-title tabular-nums tracking-[0.2em]" data-testid="github-user-code">
            {flow.userCode}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <a href={flow.verificationUri} target="_blank" rel="noreferrer">
              {t("settings.connections.githubOpen")}
            </a>
          </Button>
          <Button
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(flow.userCode).then(() => toast.success(t("settings.connections.githubCopied")))}
          >
            {t("settings.connections.githubCopy")}
          </Button>
        </div>
        <p className="text-center text-caption text-muted-foreground" role="status">
          {t("settings.connections.githubWaiting")}
        </p>
      </div>
    );
  }
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        setError(null);
        start.mutate({ label });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="add-github-label">{t("settings.connections.label")}</Label>
        <Input id="add-github-label" value={label} onChange={e => setLabel(e.target.value)} placeholder={t("settings.connections.labelPlaceholder")} />
      </div>
      <FormError message={error} />
      <Button type="submit" disabled={start.isPending}>
        {t("settings.connections.githubStart")}
      </Button>
    </form>
  );
}

/** Which repositories of a connection to follow: the others leave the sync and the lists (their time stays). */
function RepoChooser({ id, onDone }: { id: number; onDone: () => void }) {
  const refresh = useRefresh();
  const list = trpc.connections.containers.useQuery({ id });
  const [left, setLeft] = useState<Set<string> | null>(null);
  const excluded = left ?? new Set((list.data ?? []).filter(c => c.excluded).map(c => c.key));
  const save = trpc.connections.setExcluded.useMutation({
    onSuccess: () => {
      toast.success(t("settings.connections.reposSaved"));
      refresh();
      onDone();
    },
    onError: e => toast.error(e.message),
  });
  if (list.isPending) return <p className="text-body-sm text-muted-foreground">{t("common.loading")}</p>;
  if ((list.data ?? []).length === 0) return <p className="text-body-sm text-muted-foreground">{t("settings.connections.reposNone")}</p>;
  const toggle = (key: string, on: boolean) => {
    const next = new Set(excluded);
    if (on) next.delete(key);
    else next.add(key);
    setLeft(next);
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        save.mutate({ id, keys: [...excluded] });
      }}
    >
      <ul className="grid max-h-80 gap-1.5 overflow-y-auto">
        {list.data?.map(c => (
          <li key={c.id}>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox checked={!excluded.has(c.key)} onCheckedChange={on => toggle(c.key, on === true)} />
              {c.key}
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

type How = "jiraLogin" | "oauthDevice" | "token";

/** What connecting by this way asks of the person. */
function howHint(how: How, name: string): string {
  return how === "jiraLogin" ? t("pages.login.passwordHint") : how === "token" ? t("settings.connections.tokenHint", { name }) : t("settings.connections.oauthHint", { name });
}

/** A tracker connected with a personal token (its address too when self-hosted); a reconnection asks the token only. */
function TokenForm({ type, asksAddress, reconnect, onDone }: { type: string; asksAddress: boolean; reconnect?: { id: number }; onDone: () => void }) {
  const refresh = useRefresh();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    toast.success(t("settings.connections.connected"));
    refresh();
    onDone();
  };
  const add = trpc.connections.connectToken.useMutation({ onSuccess: done, onError: e => setError(e.message) });
  const again = trpc.connections.reconnectToken.useMutation({ onSuccess: done, onError: e => setError(e.message) });
  const pending = add.isPending || again.isPending;
  return (
    <form
      className="grid gap-3"
      onSubmit={e => {
        e.preventDefault();
        setError(null);
        if (reconnect) again.mutate({ id: reconnect.id, token });
        else add.mutate({ type: type as never, token, label, ...(asksAddress ? { baseUrl } : {}) });
      }}
    >
      {asksAddress && !reconnect && (
        <div className="grid gap-2">
          <Label htmlFor="token-base">{t("settings.connections.address")}</Label>
          <Input id="token-base" type="url" required value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://" />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="token-secret">{t("settings.connections.token")}</Label>
        <Input id="token-secret" type="password" required autoComplete="off" value={token} onChange={e => setToken(e.target.value)} />
      </div>
      {!reconnect && (
        <div className="grid gap-2">
          <Label htmlFor="token-label">{t("settings.connections.label")}</Label>
          <Input id="token-label" value={label} onChange={e => setLabel(e.target.value)} placeholder={t("settings.connections.labelPlaceholder")} />
        </div>
      )}
      <FormError message={error} />
      <Button type="submit" disabled={pending || token.trim().length < 8}>
        {reconnect ? t("settings.connections.reconnect") : t("settings.connections.connect")}
      </Button>
    </form>
  );
}

/** The services inkledger can connect, and the form of the one picked. */
function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const catalog = trpc.connections.catalog.useQuery(undefined, { enabled: open, staleTime: 5 * 60_000 });
  const [picked, setPicked] = useState<{ type: string; name: string; how: How; asksAddress: boolean; verified: boolean } | null>(null);
  const close = (o: boolean) => {
    if (!o) setPicked(null);
    onOpenChange(o);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{picked ? t("settings.connections.addNamed", { name: picked.name }) : t("settings.connections.add")}</DialogTitle>
          <DialogDescription>{picked ? howHint(picked.how, picked.name) : t("settings.connections.addHint")}</DialogDescription>
        </DialogHeader>
        {picked?.how === "jiraLogin" ? (
          <JiraForm onDone={() => close(false)} />
        ) : picked?.how === "oauthDevice" ? (
          <GitHubForm onDone={() => close(false)} />
        ) : picked?.how === "token" ? (
          <>
            {!picked.verified && <p className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-caption">{t("settings.connections.unverifiedHint", { name: picked.name })}</p>}
            <TokenForm type={picked.type} asksAddress={picked.asksAddress} onDone={() => close(false)} />
          </>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {catalog.data?.map(c => {
              const ready = c.how !== null && c.status !== "planned";
              return (
                <li key={c.type}>
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => c.how && setPicked({ type: c.type, name: c.name, how: c.how, asksAddress: c.asksAddress, verified: c.status !== "experimental" })}
                    className="flex w-full flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent"
                  >
                    <span className="text-body-sm font-medium">{c.name}</span>
                    <span className="text-caption text-muted-foreground">
                      {!ready ? t("settings.connections.soon") : c.status === "experimental" ? t("settings.connections.unverified") : t("settings.connections.ready")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A connection's options, each a choice; a change reads everything again with it. */
function ConnectionOptions({ c }: { c: Shown }) {
  const refresh = useRefresh();
  const resync = trpc.issues.syncConnection.useMutation({ onSettled: refresh });
  const set = trpc.connections.setOption.useMutation({
    onSuccess: () => {
      toast.success(t("settings.connections.optionSaved"));
      resync.mutate({ id: c.id, reconcile: true });
      refresh();
    },
    onError: e => toast.error(e.message),
  });
  return (
    <div className="grid gap-4">
      {c.settings.map(s => (
        <div key={s.key} className="grid gap-2">
          <Label htmlFor={`opt-${c.id}-${s.key}`}>{optionLabel(s.key)}</Label>
          <Select value={s.value} onValueChange={value => set.mutate({ id: c.id, key: s.key, value })}>
            <SelectTrigger id={`opt-${c.id}-${s.key}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {s.choices.map(v => (
                <SelectItem key={v} value={v}>
                  {choiceLabel(s.key, v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      {c.standsIn ? <StandIn c={c} standsIn={c.standsIn} /> : c.role === "timeSink" && <SinkMappings id={c.id} />}
      {!c.verified && <AllowWrites c={c} />}
      <WebhookOption id={c.id} />
    </div>
  );
}

/**
 * Where a time sink files the time: a project/task found by its search, for
 * everything (the default) or for one project of a tracker; the activity it
 * asks for when it keeps them.
 */
function SinkMappings({ id }: { id: number }) {
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [container, setContainer] = useState<number | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const targets = trpc.sinks.targets.useQuery({ id, query }, { staleTime: 30_000 });
  const activities = trpc.sinks.activities.useQuery({ id }, { staleTime: 5 * 60_000 });
  const mappings = trpc.sinks.mappings.useQuery({ id });
  const done = () => void utils.sinks.mappings.invalidate({ id });
  const map = trpc.sinks.map.useMutation({ onSuccess: () => (toast.success(t("settings.connections.sink.mapped")), done()), onError: e => toast.error(e.message) });
  const unmap = trpc.sinks.unmap.useMutation({ onSuccess: done, onError: e => toast.error(e.message) });
  if (targets.data?.use === "none") return <p className="text-caption text-muted-foreground">{t("settings.connections.sink.noTargets")}</p>;
  const nameOf = (cid: number | null) => (cid === null ? t("settings.connections.sink.everything") : (mappings.data?.containers.find(x => x.id === cid)?.key ?? String(cid)));
  return (
    <div className="grid gap-3">
      <p className="text-body-sm font-medium">{t("settings.connections.sink.title")}</p>
      {(mappings.data?.failed ?? 0) > 0 && <p className="text-caption text-warning">{t("settings.connections.sink.failed", { count: mappings.data?.failed ?? 0 })}</p>}
      <ul className="grid gap-1 text-body-sm">
        {(mappings.data?.mappings ?? []).map(m => (
          <li key={m.containerId ?? 0} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {nameOf(m.containerId)} → <span className="font-medium">{m.target.name}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => unmap.mutate({ id, containerId: m.containerId })}>
              {t("settings.connections.sink.unmap")}
            </Button>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 rounded-lg border p-2">
        <Label htmlFor={`sink-container-${id}`} className="text-caption">{t("settings.connections.sink.for")}</Label>
        <select id={`sink-container-${id}`} className="h-8 rounded-md border bg-background px-2 text-body-sm" value={container ?? ""} onChange={e => setContainer(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t("settings.connections.sink.everything")}</option>
          {(mappings.data?.containers ?? []).map(x => (
            <option key={x.id} value={x.id}>
              {x.key}
            </option>
          ))}
        </select>
        {activities.data && activities.data.items.length > 0 && (
          <>
            <Label htmlFor={`sink-activity-${id}`} className="text-caption">{t("settings.connections.sink.activity")}</Label>
            <select id={`sink-activity-${id}`} className="h-8 rounded-md border bg-background px-2 text-body-sm" value={activity ?? ""} onChange={e => setActivity(e.target.value || null)}>
              {activities.data.required === "no" && <option value="">—</option>}
              {activities.data.items.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </>
        )}
        <Label htmlFor={`sink-search-${id}`} className="text-caption">{t("settings.connections.sink.search")}</Label>
        <Input id={`sink-search-${id}`} className="h-8" value={query} onChange={e => setQuery(e.target.value)} placeholder={t("settings.connections.sink.searchPlaceholder")} />
        <ul className="grid max-h-40 gap-1 overflow-y-auto">
          {(targets.data?.items ?? []).map(tg => (
            <li key={tg.remoteId}>
              <button
                type="button"
                className="w-full rounded-md px-2 py-1 text-left text-body-sm hover:bg-accent"
                onClick={() => map.mutate({ id, containerId: container, target: tg, activityId: activity ?? (activities.data?.required !== "no" ? (activities.data?.items[0]?.id ?? null) : null) })}
              >
                {[...tg.path.map(p => p.name), tg.name].join(" / ")}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * A time sink standing in for one tracker connection (Tempo for its Jira):
 * which one. From then on that tracker's new worklogs are filed on the sink.
 */
function StandIn({ c, standsIn }: { c: Shown; standsIn: NonNullable<Shown["standsIn"]> }) {
  const refresh = useRefresh();
  const list = trpc.connections.list.useQuery();
  const set = trpc.connections.standIn.useMutation({
    onSuccess: () => {
      toast.success(t("settings.connections.optionSaved"));
      refresh();
    },
    onError: e => toast.error(e.message),
  });
  const trackers = (list.data ?? []).filter(o => o.type === standsIn.tracker);
  const NONE = "none";
  return (
    <div className="grid gap-2">
      <Label htmlFor={`standin-${c.id}`}>{t("settings.connections.standIn", { name: c.name, tracker: providerName(standsIn.tracker) })}</Label>
      <Select value={standsIn.connectionId === null ? NONE : String(standsIn.connectionId)} onValueChange={v => set.mutate({ id: c.id, trackerId: v === NONE ? null : Number(v) })}>
        <SelectTrigger id={`standin-${c.id}`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t("settings.connections.standInNone")}</SelectItem>
          {trackers.map(o => (
            <SelectItem key={o.id} value={String(o.id)}>
              {o.label || o.displayName || o.host}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-caption text-muted-foreground">{t("settings.connections.standInHint", { name: c.name, tracker: providerName(standsIn.tracker) })}</p>
    </div>
  );
}

/** Writes on an integration not verified on a real account: off until the person allows them here. */
function AllowWrites({ c }: { c: Shown }) {
  const refresh = useRefresh();
  const set = trpc.connections.allowWrites.useMutation({ onSuccess: refresh, onError: e => toast.error(e.message) });
  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`writes-${c.id}`}>{t("settings.connections.allowWrites", { name: c.name })}</Label>
        <Switch id={`writes-${c.id}`} checked={c.writesAllowed} disabled={set.isPending} onCheckedChange={on => set.mutate({ id: c.id, on })} />
      </div>
      <p className="text-caption text-muted-foreground">{t("settings.connections.allowWritesHint", { name: c.name })}</p>
    </div>
  );
}

/**
 * Webhooks (off by default): the tracker tells inkledger at once when
 * something changes, so the connection reads again sooner. Only useful when
 * the tracker can reach this server.
 */
function WebhookOption({ id }: { id: number }) {
  const utils = trpc.useUtils();
  const hook = trpc.connections.webhook.useQuery({ id });
  const set = trpc.connections.setWebhook.useMutation({
    onSuccess: () => void utils.connections.webhook.invalidate({ id }),
    onError: e => toast.error(e.message),
  });
  if (!hook.data?.available) return null;
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success(t("settings.connections.webhook.copied")));
  const url = hook.data.on ? `${window.location.origin}${hook.data.path}` : "";
  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`hook-${id}`}>{t("settings.connections.webhook.label")}</Label>
        <Switch id={`hook-${id}`} checked={hook.data.on} disabled={set.isPending} onCheckedChange={on => set.mutate({ id, on })} />
      </div>
      <p className="text-caption text-muted-foreground">{t("settings.connections.webhook.hint")}</p>
      {hook.data.on && (
        <div className="grid gap-1.5">
          <Label htmlFor={`hook-url-${id}`} className="text-caption">{t("settings.connections.webhook.url")}</Label>
          <div className="flex gap-1.5">
            <Input id={`hook-url-${id}`} readOnly value={url} className="h-8" />
            <Button type="button" variant="outline" size="sm" onClick={() => copy(url)}>
              {t("settings.connections.webhook.copy")}
            </Button>
          </div>
          <Label htmlFor={`hook-secret-${id}`} className="text-caption">{t("settings.connections.webhook.secret")}</Label>
          <div className="flex gap-1.5">
            <Input id={`hook-secret-${id}`} readOnly type="password" value={hook.data.secret} className="h-8" />
            <Button type="button" variant="outline" size="sm" onClick={() => copy(hook.data.on ? hook.data.secret : "")}>
              {t("settings.connections.webhook.copy")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** An option's name, in the app's language (its key when unknown). */
function optionLabel(key: string): string {
  return key === "mine" ? t("settings.connections.option.mine") : key;
}

/** A choice's words, in the app's language (its value when unknown). */
function choiceLabel(key: string, value: string): string {
  if (key !== "mine") return value;
  switch (value) {
    case "assigned":
      return t("settings.connections.option.mineAssigned");
    case "involved":
      return t("settings.connections.option.mineInvolved");
    case "followed":
      return t("settings.connections.option.mineFollowed");
    default:
      return value;
  }
}

function ConnectionCard({ c, onReconnect }: { c: Shown; onReconnect: () => void }) {
  const refresh = useRefresh();
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [options, setOptions] = useState(false);
  const [label, setLabel] = useState(c.label);
  const test = trpc.connections.test.useMutation({
    onSuccess: r => {
      toast.success(t("settings.connections.tested", { who: r.signedInAs, sources: r.sources.join(", ") }));
      refresh();
    },
    onError: e => toast.error(e.message),
  });
  const rename = trpc.connections.rename.useMutation({
    onSuccess: () => {
      setRenaming(false);
      refresh();
    },
    onError: e => toast.error(e.message),
  });
  const archive = trpc.connections.archive.useMutation({
    onSuccess: () => {
      toast.success(t("settings.connections.archived", { name: c.label || c.host }));
      refresh();
    },
    onError: e => toast.error(e.message),
  });
  // One connection now: its changes, or everything again (asking for what it no longer lists).
  const syncNow = trpc.issues.syncConnection.useMutation({
    onSuccess: (_r, v) => {
      toast.success(v.reconcile ? t("settings.connections.reconciled", { name: c.label || c.host }) : t("settings.connections.synced", { name: c.label || c.host }));
      refresh();
    },
    onError: e => toast.error(e.message),
  });
  const title = c.label || c.host;
  return (
    <li className="flex items-center gap-3 py-3">
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-strong">
        <Plug className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-sm font-medium">
          {title}
          <span className="ml-2 text-caption font-normal text-muted-foreground">{c.name}</span>
          {!c.verified && <span className="ml-2 rounded-sm bg-warning-soft px-1.5 py-0.5 text-caption font-medium text-warning">{t("settings.connections.badgeUnverified")}</span>}
        </p>
        <p className="truncate text-caption text-muted-foreground">
          {[
            c.label ? c.host : null,
            c.displayName,
            c.status !== "ok"
              ? t("settings.connections.needsReconnect")
              : c.lastError
                ? t("settings.connections.lastError", { message: c.lastError })
                : c.lastSyncAt
                  ? t("settings.connections.lastSync", { when: relevanceText(new Date(c.lastSyncAt).getTime()) })
                  : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("settings.connections.actions", { name: title })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={test.isPending} onSelect={() => test.mutate({ id: c.id })}>
            {t("settings.connections.test")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={syncNow.isPending} onSelect={() => syncNow.mutate({ id: c.id, reconcile: false })}>
            {t("settings.connections.syncNow")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={syncNow.isPending} onSelect={() => syncNow.mutate({ id: c.id, reconcile: true })}>
            {t("settings.connections.reconcileNow")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>{t("settings.connections.rename")}</DropdownMenuItem>
          {c.excludable && <DropdownMenuItem onSelect={() => setChoosing(true)}>{t("settings.connections.repos")}</DropdownMenuItem>}
          {(c.settings.length > 0 || !c.verified || c.role === "timeSink" || (c.role === "tracker" && c.capabilities.sync.webhooks !== null)) && (
            <DropdownMenuItem onSelect={() => setOptions(true)}>{t("settings.connections.options")}</DropdownMenuItem>
          )}
          {c.how && <DropdownMenuItem onSelect={onReconnect}>{t("settings.connections.reconnect")}</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setArchiving(true)}>{t("settings.connections.archive")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={options} onOpenChange={setOptions}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.connections.optionsTitle", { name: title })}</DialogTitle>
            <DialogDescription>{t("settings.connections.optionsHint")}</DialogDescription>
          </DialogHeader>
          {options && <ConnectionOptions c={c} />}
        </DialogContent>
      </Dialog>

      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.connections.reposTitle", { name: title })}</DialogTitle>
            <DialogDescription>{t("settings.connections.reposHint")}</DialogDescription>
          </DialogHeader>
          {choosing && <RepoChooser id={c.id} onDone={() => setChoosing(false)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.connections.rename")}</DialogTitle>
            <DialogDescription>{c.host}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={e => {
              e.preventDefault();
              rename.mutate({ id: c.id, label });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor={`rename-${c.id}`}>{t("settings.connections.label")}</Label>
              <Input id={`rename-${c.id}`} value={label} onChange={e => setLabel(e.target.value)} placeholder={c.host} />
            </div>
            <Button type="submit" disabled={rename.isPending}>
              {t("common.save")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.connections.archiveTitle", { name: title })}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.connections.archiveHint")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => archive.mutate({ id: c.id })}>{t("settings.connections.archive")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function ConnectionsSection() {
  const list = trpc.connections.list.useQuery();
  // Arriving from the reconnect bar: that connection's form, open; from the first-tracker bar: the catalogue.
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(() => params.get("add") === "1");
  const asked = Number(params.get("reconnect"));
  const [reconnecting, setReconnecting] = useState<number | null>(() => (asked > 0 ? asked : null));
  const target = list.data?.find(c => c.id === reconnecting) ?? (reconnecting !== null ? list.data?.find(c => c.status !== "ok") : undefined);
  const closeReconnect = () => {
    setReconnecting(null);
    if (params.has("reconnect")) {
      params.delete("reconnect");
      setParams(params, { replace: true });
    }
  };
  return (
    <SettingsGroup
      id="connections-list"
      title={t("settings.connections.title")}
      description={t("settings.connections.description")}
      keywords={t("settings.connections.keywords")}
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          {t("settings.connections.add")}
        </Button>
      }
    >
      {list.data?.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.connections.none")}</p>
      ) : (
        <ul className="divide-y">
          {list.data?.map(c => <ConnectionCard key={c.id} c={c} onReconnect={() => setReconnecting(c.id)} />)}
        </ul>
      )}
      <AddDialog open={adding} onOpenChange={setAdding} />
      <Dialog open={!!target} onOpenChange={o => !o && closeReconnect()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.connections.reconnectTitle", { name: target ? target.label || target.host : "" })}</DialogTitle>
            <DialogDescription>{target?.how ? howHint(target.how, target.name) : null}</DialogDescription>
          </DialogHeader>
          {/* Signing in again as the same account updates its connection. */}
          {target?.how === "jiraLogin" && <JiraForm reconnect={target} onDone={closeReconnect} />}
          {target?.how === "oauthDevice" && <GitHubForm onDone={closeReconnect} />}
          {target?.how === "token" && <TokenForm type={target.type} asksAddress={false} reconnect={target} onDone={closeReconnect} />}
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
