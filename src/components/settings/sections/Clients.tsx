import { useState } from "react";
import { MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useConnections } from "@/hooks/useConnections";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

type Draft = { id?: number; name: string; aliases: string[]; containerIds: number[] };

/** A client's name, other names and projects (a project is one client's). */
function ClientForm({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const utils = trpc.useUtils();
  const connections = useConnections().data ?? [];
  const list = trpc.clients.list.useQuery();
  const [name, setName] = useState(draft.name);
  const [aliases, setAliases] = useState(draft.aliases.join(", "));
  const [picked, setPicked] = useState<number[]>(draft.containerIds);
  const [error, setError] = useState<string | null>(null);
  const save = trpc.clients.save.useMutation({
    onSuccess: () => {
      void utils.invalidate();
      toast.success(t("settings.clients.saved", { name }));
      onDone();
    },
    onError: e => setError(e.message),
  });
  const ownerOf = (containerId: number) => list.data?.clients.find(c => c.id !== draft.id && c.containerIds.includes(containerId))?.name;
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        setError(null);
        save.mutate({
          id: draft.id,
          name,
          aliases: aliases.split(",").map(a => a.trim()).filter(Boolean),
          containerIds: picked,
        });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="client-name">{t("settings.clients.name")}</Label>
        <Input id="client-name" value={name} onChange={e => setName(e.target.value)} placeholder={t("settings.clients.namePlaceholder")} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="client-aliases">{t("settings.clients.aliases")}</Label>
        <Input id="client-aliases" value={aliases} onChange={e => setAliases(e.target.value)} placeholder={t("settings.clients.aliasesPlaceholder")} />
      </div>
      <fieldset className="grid max-h-80 gap-3 overflow-y-auto">
        <legend className="mb-1 text-body-sm font-medium">{t("settings.clients.projects")}</legend>
        {connections.map(c => {
          const own = (list.data?.containers ?? []).filter(x => x.connectionId === c.id);
          if (own.length === 0) return null;
          return (
            <div key={c.id} className="grid gap-1.5">
              <p className="text-body-sm font-medium">{c.label || c.host}</p>
              {own.map(x => {
                const other = ownerOf(x.id);
                return (
                  <label key={x.id} className="ml-2 flex items-center gap-2 text-body-sm">
                    <Checkbox
                      checked={picked.includes(x.id)}
                      onCheckedChange={on => setPicked(prev => (on === true ? [...prev, x.id] : prev.filter(p => p !== x.id)))}
                    />
                    {x.key}
                    {x.name && x.name !== x.key && !x.key.endsWith(`/${x.name}`) && <span className="text-muted-foreground">{x.name}</span>}
                    {other && <span className="text-caption text-muted-foreground">· {t("settings.clients.nowOf", { name: other })}</span>}
                  </label>
                );
              })}
            </div>
          );
        })}
      </fieldset>
      <FormError message={error} />
      <Button type="submit" disabled={save.isPending || name.trim() === ""}>
        {t("common.save")}
      </Button>
    </form>
  );
}

/** Settings → Clients: who the work is for, across trackers; suggested from their groups. */
export function ClientsSection() {
  const utils = trpc.useUtils();
  const list = trpc.clients.list.useQuery();
  const [asked, setAsked] = useState(false);
  const suggestions = trpc.clients.suggestions.useQuery(undefined, { enabled: asked, staleTime: 60_000 });
  const [editing, setEditing] = useState<Draft | null>(null);
  const remove = trpc.clients.delete.useMutation({ onSuccess: () => void utils.invalidate(), onError: e => toast.error(e.message) });
  const clients = list.data?.clients ?? [];
  return (
    <SettingsGroup
      id="clients-list"
      title={t("settings.clients.title")}
      description={t("settings.clients.description")}
      keywords={t("settings.clients.keywords")}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setAsked(true)} disabled={suggestions.isFetching}>
            <Sparkles />
            {t("settings.clients.suggest")}
          </Button>
          <Button size="sm" onClick={() => setEditing({ name: "", aliases: [], containerIds: [] })}>
            <Plus />
            {t("settings.clients.new")}
          </Button>
        </>
      }
    >
      {asked && suggestions.data && (
        <div {...surface("card")} className="mb-4 grid gap-2 rounded-lg border p-3">
          <p className="text-body-sm font-medium">{t("settings.clients.suggested")}</p>
          {suggestions.data.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t("settings.clients.noSuggestion")}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {suggestions.data.map(s => (
                <li key={s.name}>
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ name: s.name, aliases: [], containerIds: s.containerIds })}>
                    {t("settings.clients.useSuggestion", { name: s.name, count: s.containerIds.length })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {clients.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.clients.none")}</p>
      ) : (
        <ul className="divide-y">
          {clients.map(c => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-sm font-medium">{c.name}</p>
                <p className="truncate text-caption text-muted-foreground">
                  {[t("settings.clients.projectCount", { count: c.containerIds.length }), c.aliases.join(", ")].filter(Boolean).join(" · ")}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t("settings.clients.actions", { name: c.name })}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditing({ id: c.id, name: c.name, aliases: c.aliases, containerIds: c.containerIds })}>{t("settings.clients.edit")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => remove.mutate({ id: c.id })}>{t("settings.clients.delete")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? t("settings.clients.edit") : t("settings.clients.new")}</DialogTitle>
            <DialogDescription>{t("settings.clients.formHint")}</DialogDescription>
          </DialogHeader>
          {editing && <ClientForm draft={editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
