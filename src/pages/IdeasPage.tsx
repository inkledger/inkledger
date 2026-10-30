import { useState } from "react";
import { useSearchParams } from "react-router";
import { Minus } from "lucide-react";
import { toast } from "sonner";
import { canMove, IDEA_STATES, type IdeaState } from "@contracts/ideas";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelSection } from "@/components/app/Panel";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { EmptyState, ErrorState, PageSpinner } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IdeaCapture } from "@/components/ideas/IdeaCapture";
import { IdeaCard, type Idea } from "@/components/ideas/IdeaCard";
import { IdeaSheet } from "@/components/ideas/IdeaSheet";
import { useCollapsedColumns } from "@/hooks/useCollapsedColumns";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type View = "columns" | "list";
const VIEW_KEY = "ikl-ideas-view";
/** Shown by default: the ones still being worked on; the others open on request. */
const TERMINAL: readonly IdeaState[] = ["promoted", "discarded"];

/** Columns on wide screens, a list on narrow ones, unless the user chose (a per-browser convenience). */
function initialView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "columns" || saved === "list") return saved;
  } catch {
    // storage unavailable: the default
  }
  return typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches ? "columns" : "list";
}

/** Ideas in triage (docs/work/ideas/triage.md): captured raw, refined until ready, then on their way. */
export default function IdeasPage() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>(initialView);
  const [project, setProject] = useState<string>("all");
  const [announce, setAnnounce] = useState("");
  const utils = trpc.useUtils();
  const projects = trpc.ideas.projects.useQuery(undefined, { staleTime: 5 * 60_000 });
  const list = trpc.ideas.list.useQuery(project === "all" ? {} : { containerId: project === "none" ? "none" : Number(project) });
  const { collapsed, toggle } = useCollapsedColumns("ideas");
  const openId = Number(params.get("open")) || null;
  const setOpen = (id: number | null) =>
    setParams(
      p => {
        if (id === null) p.delete("open");
        else p.set("open", String(id));
        return p;
      },
      { replace: true },
    );
  const refresh = () => {
    void utils.ideas.list.invalidate();
    void utils.ideas.counts.invalidate();
  };
  const move = trpc.ideas.move.useMutation({ onError: e => toastError(e), onSettled: refresh });
  const remove = trpc.ideas.remove.useMutation({ onError: e => toastError(e), onSettled: refresh });
  const restore = trpc.ideas.restore.useMutation({ onError: e => toastError(e), onSettled: refresh });

  const ideas = list.data ?? [];
  const inState = (s: IdeaState) => ideas.filter(i => i.state === s);

  /** To another column, at its end; refused moves say why and leave it where it was. */
  const moveTo = (idea: Idea, to: IdeaState) => {
    if (to === idea.state) return;
    const ok = canMove(idea, to);
    if (!ok.ok) {
      toast.error(t(`server.ideas.move.${ok.reason}`));
      return;
    }
    move.mutate({ id: idea.id, state: to, index: inState(to).length });
    setAnnounce(t("pages.ideas.moved", { title: idea.title, state: t(`pages.ideas.state.${to}`) }));
  };
  const deleteIdea = (idea: Idea) => {
    if (openId === idea.id) setOpen(null);
    remove.mutate(
      { id: idea.id },
      { onSuccess: () => toast.success(t("pages.ideas.deleted"), { action: { label: t("pages.ideas.undo"), onClick: () => restore.mutate({ id: idea.id }) } }) },
    );
  };
  const chooseView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // not kept: still applied
    }
  };
  /** A terminal column is shown when opened; the others unless closed (one setting, two senses). */
  const isOpen = (s: IdeaState) => (TERMINAL.includes(s) ? collapsed.has(`open-${s}`) : !collapsed.has(s));
  const toggleColumn = (s: IdeaState) => toggle(TERMINAL.includes(s) ? `open-${s}` : s);

  const cards = (items: Idea[]) => (
    <ul className="grid gap-2">
      {items.map(i => (
        <IdeaCard key={i.id} idea={i} onOpen={() => setOpen(i.id)} onMove={to => moveTo(i, to)} onDelete={() => deleteIdea(i)} />
      ))}
    </ul>
  );

  const column = (s: IdeaState) => {
    const items = inState(s);
    const dropProps = {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("application/x-idea")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDrop: (e: React.DragEvent) => {
        const id = Number(e.dataTransfer.getData("application/x-idea"));
        const idea = ideas.find(i => i.id === id);
        if (!idea) return;
        e.preventDefault();
        moveTo(idea, s);
      },
    };
    if (!isOpen(s))
      return (
        <section key={s} aria-label={t(`pages.ideas.state.${s}`)} className="flex w-11 shrink-0 flex-col" {...dropProps}>
          <Button variant="outline" size="sm" className="h-auto min-h-24 px-0 py-3 [writing-mode:vertical-rl]" onClick={() => toggleColumn(s)} aria-label={t("pages.ideas.showColumn", { state: t(`pages.ideas.state.${s}`), count: items.length })}>
            {t(`pages.ideas.state.${s}`)} · {items.length}
          </Button>
        </section>
      );
    return (
      <section key={s} aria-label={t(`pages.ideas.state.${s}`)} data-column={s} className="flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/50 p-2" {...dropProps}>
        <header className="flex items-center justify-between gap-2 px-1">
          <h2 className="text-body-sm font-medium">
            {t(`pages.ideas.state.${s}`)} <span className="text-muted-foreground tabular">{items.length}</span>
          </h2>
          <Button variant="ghost" size="icon-sm" onClick={() => toggleColumn(s)} aria-label={t("pages.ideas.hideColumn", { state: t(`pages.ideas.state.${s}`) })}>
            <Minus className="h-4 w-4" aria-hidden />
          </Button>
        </header>
        {cards(items)}
      </section>
    );
  };

  return (
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <PageHeader
        title={t("pages.ideas.title")}
        description={t("pages.ideas.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger className="w-44" aria-label={t("pages.ideas.project")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("pages.ideas.allProjects")}</SelectItem>
                <SelectItem value="none">{t("pages.ideas.noProject")}</SelectItem>
                {(projects.data ?? []).map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.key} · {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SegmentedControl<View>
              label={t("pages.ideas.view")}
              value={view}
              onChange={chooseView}
              options={[
                { value: "columns", label: t("pages.ideas.viewColumns") },
                { value: "list", label: t("pages.ideas.viewList") },
              ]}
            />
          </div>
        }
      />
      <PanelSection title={t("pages.ideas.captureLabel")} className="border-b">
        <IdeaCapture {...(project !== "all" && project !== "none" ? { containerId: Number(project) } : {})} />
      </PanelSection>
      <PanelSection className="flex min-h-0 flex-1 flex-col">
        {list.isError ? (
          <ErrorState onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <PageSpinner />
        ) : ideas.length === 0 ? (
          <EmptyState title={t("pages.ideas.title")} message={t("pages.ideas.empty")} />
        ) : view === "columns" ? (
          // The board scrolls sideways inside itself, never the page.
          <div className={cn("flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2")} data-overflow-ok>
            {IDEA_STATES.map(column)}
          </div>
        ) : (
          <div className="grid gap-5">
            {IDEA_STATES.filter(s => inState(s).length > 0).map(s => (
              <section key={s} aria-label={t(`pages.ideas.state.${s}`)}>
                <h2 className="mb-2 text-body-sm font-medium">
                  {t(`pages.ideas.state.${s}`)} <span className="text-muted-foreground tabular">{inState(s).length}</span>
                </h2>
                {cards(inState(s))}
              </section>
            ))}
          </div>
        )}
      </PanelSection>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <IdeaSheet
        ideaId={openId}
        onClose={() => setOpen(null)}
        onDiscard={idea => moveTo(idea, "discarded")}
        onDelete={deleteIdea}
      />
    </div>
  );
}
