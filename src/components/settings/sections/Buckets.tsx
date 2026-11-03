import { toastError, failureText } from "@/lib/errorText";
import { useState } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useBuckets } from "@/hooks/useBuckets";
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
import { cn } from "@/lib/utils";

/** A status chip dragged between the editor's columns (only those; dropped text is ignored). */
const STATUS_DRAG = "application/x-bucket-status";

type Source = { connectionId: number; containerId: number | null };
type BoardMode = "lanes" | "category" | "custom";
type Column = { name: string; statuses: Record<string, string[]> };
type Draft = { id?: number; name: string; sources: Source[]; query: string; boardMode: BoardMode; columns: Column[] };
const EMPTY: Draft = { name: "", sources: [], query: "", boardMode: "lanes", columns: [] };

/**
 * The bucket's own board columns: a name each, and which statuses of each of
 * its trackers fall in it (a status in one column at most), set on a board
 * of the columns by dragging the statuses or from each one's menu.
 */
function ColumnsEditor({ connectionIds, columns, onChange }: { connectionIds: number[]; columns: Column[]; onChange: (c: Column[]) => void }) {
  const connections = useConnections().data ?? [];
  const statuses = trpc.buckets.statuses.useQuery(undefined, { staleTime: 60_000 }).data ?? [];
  const [dragOver, setDragOver] = useState<string | null>(null);
  const set = (i: number, c: Column) => onChange(columns.map((x, j) => (j === i ? c : x)));
  const where = (conn: number, status: string) => columns.findIndex(c => (c.statuses[String(conn)] ?? []).includes(status));
  const assign = (conn: number, status: string, to: number) =>
    onChange(
      columns.map((c, j) => {
        const list = (c.statuses[String(conn)] ?? []).filter(s => s !== status);
        return { ...c, statuses: { ...c.statuses, [String(conn)]: j === to ? [...list, status] : list } };
      })
    );
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="grid gap-3">
      {columns.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input aria-label={t("settings.buckets.columnName", { n: i + 1 })} value={c.name} onChange={e => set(i, { ...c, name: e.target.value })} className="h-8" />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("settings.buckets.columnUp", { name: c.name })} disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("settings.buckets.columnDown", { name: c.name })} disabled={i === columns.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("settings.buckets.columnRemove", { name: c.name })} onClick={() => onChange(columns.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </div>
      ))}
      {columns.length < 12 && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...columns, { name: t("settings.buckets.columnDefault", { n: columns.length + 1 }), statuses: {} }])}>
          <Plus />
          {t("settings.buckets.columnAdd")}
        </Button>
      )}
      {/* The board itself is the editor: each status a chip, dragged into its column; its menu moves it by
          keyboard (or screen reader). A status sits in one column at most, as the Board draws it. */}
      {columns.length > 0 &&
        connectionIds.map(conn => {
          const own = statuses.filter(s => s.connectionId === conn);
          if (own.length === 0) return null;
          const c = connections.find(x => x.id === conn);
          const name = c ? c.label || c.name : String(conn);
          const targets = [{ index: -1, name: t("settings.buckets.noColumn") }, ...columns.map((col, index) => ({ index, name: col.name }))];
          return (
            <section key={conn} aria-label={t("settings.buckets.mapOf", { name })} className="region grid gap-1.5">
              <p className="text-caption font-medium text-muted-foreground">{name}</p>
              <div {...surface("ground")} className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 rounded-lg border bg-muted/30 p-2">
                {targets.map(target => {
                  const inIt = own.filter(s => where(conn, s.status) === target.index);
                  const over = dragOver === `${conn}:${target.index}`;
                  return (
                    <div
                      key={target.index}
                      role="group"
                      aria-label={`${target.name} (${inIt.length})`}
                      data-bucket-column={target.index}
                      {...surface(target.index === -1 ? "glass" : "card")}
                      className={cn("min-h-20 rounded-md border p-1.5 transition-colors", target.index === -1 ? "border-dashed bg-transparent" : "bg-card", over && "ring-2 ring-ring")}
                      onDragOver={e => {
                        if (!e.dataTransfer.types.includes(STATUS_DRAG)) return;
                        e.preventDefault();
                        setDragOver(`${conn}:${target.index}`);
                      }}
                      onDragLeave={() => setDragOver(v => (v === `${conn}:${target.index}` ? null : v))}
                      onDrop={e => {
                        setDragOver(null);
                        const raw = e.dataTransfer.getData(STATUS_DRAG);
                        if (!raw) return;
                        e.preventDefault();
                        const dropped: unknown = JSON.parse(raw);
                        if (typeof dropped === "object" && dropped !== null && "conn" in dropped && "status" in dropped && dropped.conn === conn && typeof dropped.status === "string") assign(conn, dropped.status, target.index);
                      }}
                    >
                      <p className="truncate px-1 text-caption font-semibold">
                        {target.name} <span className="font-normal text-muted-foreground tabular">{inIt.length}</span>
                      </p>
                      <ul className="mt-1 flex flex-wrap gap-1">
                        {inIt.map(st => (
                          <li
                            key={st.status}
                            draggable
                            onDragStart={e => {
                              e.dataTransfer.setData(STATUS_DRAG, JSON.stringify({ conn, status: st.status }));
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            {...surface("chip")}
                            className="flex max-w-full cursor-grab items-center rounded-md border bg-background pl-2 text-caption active:cursor-grabbing"
                          >
                            <span className="truncate">{st.status}</span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0" aria-label={t("settings.buckets.statusColumn", { status: st.status })}>
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                {targets.filter(x => x.index !== target.index).map(x => (
                                  <DropdownMenuItem key={x.index} onSelect={() => assign(conn, st.status, x.index)}>
                                    {t("settings.buckets.moveTo", { name: x.name })}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
    </div>
  );
}

const same = (a: Source, b: Source) => a.connectionId === b.connectionId && a.containerId === b.containerId;

/** Name and sources of a bucket: whole trackers, or some of their projects. */
function BucketForm({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const utils = trpc.useUtils();
  const connections = useConnections().data ?? [];
  const containers = trpc.buckets.sources.useQuery().data ?? [];
  const [name, setName] = useState(draft.name);
  const [sources, setSources] = useState<Source[]>(draft.sources);
  const [query, setQuery] = useState(draft.query);
  const [boardMode, setBoardMode] = useState<BoardMode>(draft.boardMode);
  const [columns, setColumns] = useState<Column[]>(draft.columns);
  const [error, setError] = useState<string | null>(null);
  const save = trpc.buckets.save.useMutation({
    onSuccess: () => {
      void utils.invalidate();
      toast.success(t("settings.buckets.saved", { name }));
      onDone();
    },
    onError: e => setError(failureText(e)),
  });
  const toggle = (s: Source, on: boolean) => setSources(prev => (on ? [...prev.filter(p => !same(p, s)), s] : prev.filter(p => !same(p, s))));
  const has = (s: Source) => sources.some(p => same(p, s));
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        setError(null);
        save.mutate({ id: draft.id, name, sources, query, boardMode: boardMode === "custom" && columns.length === 0 ? "lanes" : boardMode, columns: columns.filter(c => c.name.trim()) });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="bucket-name">{t("settings.buckets.name")}</Label>
        <Input id="bucket-name" value={name} onChange={e => setName(e.target.value)} placeholder={t("settings.buckets.namePlaceholder")} required />
      </div>
      <fieldset className="grid max-h-80 gap-3 overflow-y-auto">
        <legend className="mb-1 text-body-sm font-medium">{t("settings.buckets.sources")}</legend>
        {connections.map(c => {
          const whole = { connectionId: c.id, containerId: null };
          const own = containers.filter(x => x.connectionId === c.id);
          return (
            <div key={c.id} className="grid gap-1.5">
              <label className="flex items-center gap-2 text-body-sm font-medium">
                <Checkbox checked={has(whole)} onCheckedChange={on => toggle(whole, on === true)} />
                {c.label || c.host} <span className="font-normal text-muted-foreground">· {t("settings.buckets.wholeTracker", { name: c.name })}</span>
              </label>
              {!has(whole) &&
                own.map(x => {
                  const one = { connectionId: c.id, containerId: x.id };
                  return (
                    <label key={x.id} className="ml-6 flex items-center gap-2 text-body-sm">
                      <Checkbox checked={has(one)} onCheckedChange={on => toggle(one, on === true)} />
                      {x.key}
                      {x.name && x.name !== x.key && <span className="text-muted-foreground">{x.name}</span>}
                    </label>
                  );
                })}
            </div>
          );
        })}
      </fieldset>
      <div className="grid gap-2">
        <Label htmlFor="bucket-query">{t("settings.buckets.query")}</Label>
        <Input id="bucket-query" value={query} onChange={e => setQuery(e.target.value)} placeholder={t("settings.buckets.queryPlaceholder")} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="bucket-board">{t("settings.buckets.boardMode")}</Label>
        <select id="bucket-board" {...surface("control")} className="h-9 rounded-md border bg-background px-2 text-body-sm" value={boardMode} onChange={e => setBoardMode(e.target.value as BoardMode)}>
          <option value="lanes">{t("pages.board.modeLanes")}</option>
          <option value="category">{t("pages.board.modeCategory")}</option>
          <option value="custom">{t("pages.board.modeCustom")}</option>
        </select>
      </div>
      {boardMode === "custom" && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-body-sm font-medium">{t("settings.buckets.columns")}</legend>
          <ColumnsEditor connectionIds={[...new Set(sources.map(s => s.connectionId))]} columns={columns} onChange={setColumns} />
        </fieldset>
      )}
      <FormError message={error} />
      <Button type="submit" disabled={save.isPending || sources.length === 0 || name.trim() === ""}>
        {t("common.save")}
      </Button>
    </form>
  );
}

export function BucketsSection() {
  const utils = trpc.useUtils();
  const { buckets, active } = useBuckets();
  const [editing, setEditing] = useState<Draft | null>(null);
  const remove = trpc.buckets.delete.useMutation({ onSuccess: () => void utils.invalidate(), onError: e => toastError(e) });
  const order = trpc.buckets.reorder.useMutation({ onSuccess: () => void utils.buckets.list.invalidate() });
  const reorder = (i: number, d: -1 | 1) => {
    const ids = buckets.map(b => b.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    order.mutate({ ids });
  };
  return (
    <SettingsGroup
      id="buckets-list"
      title={t("settings.buckets.title")}
      description={t("settings.buckets.description")}
      keywords={t("settings.buckets.keywords")}
      actions={
        <Button size="sm" onClick={() => setEditing(EMPTY)}>
          <Plus />
          {t("settings.buckets.new")}
        </Button>
      }
    >
      {buckets.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.buckets.none")}</p>
      ) : (
        <ul className="divide-y">
          {buckets.map((b, i) => (
            <li key={b.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-sm font-medium">
                  {b.name}
                  {active?.id === b.id && <span className="ml-2 text-caption font-normal text-muted-foreground">{t("settings.buckets.onHere")}</span>}
                </p>
                <p className="truncate text-caption text-muted-foreground">{[t("settings.buckets.sourceCount", { count: b.sources.length }), b.query].filter(Boolean).join(" · ")}</p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t("settings.buckets.actions", { name: b.name })}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditing({ id: b.id, name: b.name, sources: b.sources, query: b.query, boardMode: b.boardMode, columns: b.columns.map(c => ({ name: c.name, statuses: c.statuses })) })}>
                    {t("settings.buckets.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={i === 0} onSelect={() => reorder(i, -1)}>
                    {t("settings.buckets.moveUp")}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={i === buckets.length - 1} onSelect={() => reorder(i, 1)}>
                    {t("settings.buckets.moveDown")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => remove.mutate({ id: b.id })}>{t("settings.buckets.delete")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? t("settings.buckets.edit") : t("settings.buckets.new")}</DialogTitle>
            <DialogDescription>{t("settings.buckets.formHint")}</DialogDescription>
          </DialogHeader>
          {editing && <BucketForm draft={editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
