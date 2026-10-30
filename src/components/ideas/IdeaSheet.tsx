import { useCallback, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { withOutOfScope, type Criterion, type IdeaRoute, type Question } from "@contracts/ideas";
import { useDirtyClose } from "@/components/app/DirtyClose";
import { IdeaSuggestionPanel, type SuggestionField } from "@/components/ideas/IdeaSuggestion";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { ErrorState, PageSpinner } from "@/components/app/States";
import { EstimateChip } from "@/components/todo/TodoChips";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import type { Idea } from "@/components/ideas/IdeaCard";

const newId = () => Math.random().toString(36).slice(2, 10);
type RouteChoice = IdeaRoute | "none";

/** An idea, opened: what it is, when it is done, what is still to ask, where it goes (docs/work/ideas/triage.md). Each field saves when left. */
export function IdeaSheet({
  ideaId,
  onClose,
  onPromote,
  onDiscard,
  onDelete,
}: {
  ideaId: number | null;
  onClose: () => void;
  onPromote: (idea: Idea) => void;
  onDiscard: (idea: Idea) => void;
  onDelete: (idea: Idea) => void;
}) {
  const open = ideaId !== null;
  const idea = trpc.ideas.get.useQuery({ id: ideaId ?? 0 }, { enabled: open });
  // A suggestion not used yet is asked about before closing.
  const guard = useDirtyClose(onClose);
  return (
    <>
    {guard.confirm}
    <Sheet open={open} onOpenChange={guard.onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="[overflow-wrap:anywhere]">{idea.data?.title ?? t("pages.ideas.title")}</SheetTitle>
          <SheetDescription>{idea.data ? t(`pages.ideas.state.${idea.data.state}`) : ""}</SheetDescription>
        </SheetHeader>
        {idea.isError ? (
          <ErrorState onRetry={() => void idea.refetch()} />
        ) : !idea.data ? (
          <PageSpinner />
        ) : (
          // Remounted per idea: its fields start from what is saved.
          <IdeaFields
            key={idea.data.id}
            idea={idea.data}
            onPromote={() => idea.data && onPromote(idea.data)}
            onDiscard={() => idea.data && onDiscard(idea.data)}
            onDelete={() => idea.data && onDelete(idea.data)}
            markDirty={guard.markDirty}
          />
        )}
      </SheetContent>
    </Sheet>
    </>
  );
}

function IdeaFields({ idea, onPromote, onDiscard, onDelete, markDirty }: { idea: Idea; onPromote: () => void; onDiscard: () => void; onDelete: () => void; markDirty: (dirty: boolean) => void }) {
  const utils = trpc.useUtils();
  const llm = trpc.ideas.llm.useQuery(undefined, { staleTime: 5 * 60_000 });
  const suggestion = trpc.ideas.suggest.useQuery({ id: idea.id }, { enabled: false, retry: false, staleTime: Infinity, gcTime: 0 });
  const removeIdea = trpc.ideas.remove.useMutation({ onSettled: () => void utils.ideas.list.invalidate() });
  const capture = trpc.ideas.capture.useMutation({
    onSuccess: made => {
      void utils.ideas.list.invalidate();
      void utils.ideas.counts.invalidate();
      toast.success(t("pages.ideas.splitMade", { count: made.length }), {
        action: { label: t("pages.ideas.undo"), onClick: () => made.forEach(m => removeIdea.mutate({ id: m.id })) },
      });
    },
    onError: e => toastError(e),
  });
  const projects = trpc.ideas.projects.useQuery(undefined, { staleTime: 5 * 60_000 });
  const update = trpc.ideas.update.useMutation({
    onSuccess: saved => utils.ideas.get.setData({ id: idea.id }, saved),
    onError: e => toastError(e),
    onSettled: () => void utils.ideas.list.invalidate(),
  });
  const save = (patch: Omit<Parameters<typeof update.mutate>[0], "id">) => update.mutate({ id: idea.id, ...patch });
  const addTodo = trpc.todos.add.useMutation({
    onSuccess: () => toast.success(t("pages.ideas.todoMade", { key: idea.promoted?.key ?? "" })),
    onError: e => toastError(e),
  });
  const open = idea.state !== "promoted" && idea.state !== "discarded";
  const copyPrompt = async () => {
    try {
      const h = await utils.ideas.handoff.fetch({ id: idea.id });
      await navigator.clipboard.writeText(h.markdown);
      toast.success(t("pages.ideas.promptCopied"));
    } catch (e) {
      toastError(e);
    }
  };
  const downloadPrompt = async () => {
    try {
      const h = await utils.ideas.handoff.fetch({ id: idea.id });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([h.markdown], { type: "text/markdown" }));
      a.download = h.filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toastError(e);
    }
  };
  /** The user's own mail program writes it; nothing is sent from here. */
  const writeMail = async () => {
    try {
      window.location.href = (await utils.ideas.askMail.fetch({ id: idea.id, to: null })).url;
    } catch (e) {
      toastError(e);
    }
  };
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  const [criterion, setCriterion] = useState("");
  const [question, setQuestion] = useState("");
  const setAcceptance = (acceptance: Criterion[]) => save({ acceptance });
  /** Suggested fields into the idea, in one save; "split" makes new ideas instead (triage Q5). */
  const applySuggested = (fields: SuggestionField[]) => {
    const s = suggestion.data;
    if (!s) return;
    const patch: Omit<Parameters<typeof update.mutate>[0], "id"> = {};
    let nextBody = body;
    for (const f of fields) {
      if (f === "title" && s.title?.trim()) {
        setTitle(s.title.trim());
        patch.title = s.title.trim();
      }
      if (f === "problem" && s.problem !== undefined) nextBody = s.problem;
      if (f === "outOfScope" && s.outOfScope?.length) nextBody = withOutOfScope(nextBody, s.outOfScope);
      if (f === "acceptance" && s.acceptance) patch.acceptance = [...idea.acceptance, ...s.acceptance.map(text => ({ id: newId(), text }))].slice(0, 20);
      if (f === "questions" && s.questions)
        patch.questions = [...idea.questions, ...s.questions.map(text => ({ id: newId(), text, answer: "", blocking: false }))].slice(0, 20);
      if (f === "labels" && s.labels) patch.labels = [...new Set([...idea.labels, ...s.labels])].slice(0, 20);
      if (f === "estimateMinutes" && s.estimateMinutes) patch.estimateSeconds = s.estimateMinutes * 60;
      if (f === "split" && s.split?.length) capture.mutate({ text: s.split.join("\n"), ...(idea.container ? { containerId: idea.container.id } : {}) });
    }
    if (nextBody !== body) {
      setBody(nextBody);
      patch.body = nextBody;
    }
    if (Object.keys(patch).length > 0) save(patch);
  };
  const askSuggestion = () => void suggestion.refetch().then(r => r.error && toastError(r.error));
  const onPending = useCallback((pending: boolean) => markDirty(pending), [markDirty]);
  const setQuestions = (questions: Question[]) => save({ questions });
  const route: RouteChoice = idea.route ?? "none";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-5 py-4">
      <label className="grid gap-1.5 text-body-sm">
        <span className="font-medium">{t("pages.ideas.ideaTitle")}</span>
        <Input value={title} maxLength={200} onChange={e => setTitle(e.currentTarget.value)} onBlur={() => title.trim() && title !== idea.title && save({ title })} />
      </label>
      <label className="grid gap-1.5 text-body-sm">
        <span className="font-medium">{t("pages.ideas.problem")}</span>
        <Textarea rows={5} value={body} onChange={e => setBody(e.currentTarget.value)} onBlur={() => body !== idea.body && save({ body })} />
      </label>

      <section className="grid gap-2" aria-label={t("pages.ideas.acceptance")}>
        <h3 className="text-body-sm font-medium">{t("pages.ideas.acceptance")}</h3>
        <ul className="grid gap-1">
          {idea.acceptance.map(c => (
            <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-body-sm">
              <span className="[overflow-wrap:anywhere]">{c.text}</span>
              <Button variant="ghost" size="icon-sm" aria-label={t("pages.ideas.remove", { text: c.text })} onClick={() => setAcceptance(idea.acceptance.filter(x => x.id !== c.id))}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
          onSubmit={e => {
            e.preventDefault();
            if (!criterion.trim()) return;
            setAcceptance([...idea.acceptance, { id: newId(), text: criterion.trim() }]);
            setCriterion("");
          }}
        >
          <Input aria-label={t("pages.ideas.addCriterion")} placeholder={t("pages.ideas.addCriterion")} maxLength={500} value={criterion} onChange={e => setCriterion(e.currentTarget.value)} />
          <Button type="submit" variant="outline" size="sm" disabled={!criterion.trim() || update.isPending}>
            {t("pages.ideas.add")}
          </Button>
        </form>
      </section>

      <section className="grid gap-2" aria-label={t("pages.ideas.questions")}>
        <h3 className="text-body-sm font-medium">{t("pages.ideas.questions")}</h3>
        <ul className="grid gap-3">
          {idea.questions.map(q => (
            <li key={q.id} className="grid gap-1.5 text-body-sm">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <span className="[overflow-wrap:anywhere]">{q.text}</span>
                <Button variant="ghost" size="icon-sm" aria-label={t("pages.ideas.remove", { text: q.text })} onClick={() => setQuestions(idea.questions.filter(x => x.id !== q.id))}>
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <label className="flex items-center gap-2 text-muted-foreground">
                <Switch checked={q.blocking} onCheckedChange={v => setQuestions(idea.questions.map(x => (x.id === q.id ? { ...x, blocking: v } : x)))} />
                {t("pages.ideas.blocking")}
              </label>
              <Input
                aria-label={`${t("pages.ideas.answer")}: ${q.text}`}
                placeholder={t("pages.ideas.answer")}
                maxLength={2000}
                defaultValue={q.answer}
                onBlur={e => {
                  const answer = e.currentTarget.value.trim();
                  if (answer !== q.answer) setQuestions(idea.questions.map(x => (x.id === q.id ? { ...x, answer } : x)));
                }}
              />
            </li>
          ))}
        </ul>
        <form
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
          onSubmit={e => {
            e.preventDefault();
            if (!question.trim()) return;
            setQuestions([...idea.questions, { id: newId(), text: question.trim(), answer: "", blocking: false }]);
            setQuestion("");
          }}
        >
          <Input aria-label={t("pages.ideas.addQuestion")} placeholder={t("pages.ideas.addQuestion")} maxLength={500} value={question} onChange={e => setQuestion(e.currentTarget.value)} />
          <Button type="submit" variant="outline" size="sm" disabled={!question.trim() || update.isPending}>
            {t("pages.ideas.add")}
          </Button>
        </form>
      </section>

      <div className="grid gap-1.5 text-body-sm">
        <span className="font-medium">{t("pages.ideas.project")}</span>
        <Select value={idea.container ? String(idea.container.id) : "none"} onValueChange={v => save({ containerId: v === "none" ? null : Number(v) })}>
          <SelectTrigger aria-label={t("pages.ideas.project")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("pages.ideas.noProject")}</SelectItem>
            {(projects.data ?? []).map(p => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.key} · {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5 text-body-sm">
        <span className="font-medium">{t("pages.ideas.route.label")}</span>
        <SegmentedControl<RouteChoice>
          label={t("pages.ideas.route.label")}
          value={route}
          onChange={v => save({ route: v === "none" ? null : v })}
          options={(["none", "me", "agent", "ask"] as const).map(v => ({ value: v, label: t(`pages.ideas.route.${v}`) }))}
          className="flex-wrap"
        />
      </div>

      <div className="flex items-center gap-2 text-body-sm">
        <EstimateChip seconds={idea.estimateSeconds} onChange={estimateSeconds => save({ estimateSeconds })} />
      </div>

      {suggestion.data && (
        <IdeaSuggestionPanel
          key={suggestion.dataUpdatedAt}
          suggestion={suggestion.data}
          model={llm.data?.model ?? ""}
          onUse={f => applySuggested([f])}
          onUseAll={applySuggested}
          onPending={onPending}
        />
      )}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        {llm.data?.available && (
          <Button variant="outline" size="sm" disabled={suggestion.isFetching} onClick={askSuggestion}>
            {suggestion.isFetching ? t("pages.ideas.suggesting") : t("pages.ideas.suggest")}
          </Button>
        )}
        {open && (
          <Button size="sm" onClick={onPromote}>
            {t("pages.ideas.createIssue")}
          </Button>
        )}
        {idea.promoted && idea.route === "me" && (
          <Button size="sm" disabled={addTodo.isPending} onClick={() => idea.promoted && addTodo.mutate({ text: idea.title, issueKey: idea.promoted.key, connectionId: idea.promoted.connectionId })}>
            {t("pages.ideas.makeTodo")}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void copyPrompt()}>
          {t("pages.ideas.copyPrompt")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void downloadPrompt()}>
          {t("pages.ideas.downloadPrompt")}
        </Button>
        {idea.questions.some(q => q.answer.trim() === "") && (
          <Button variant="outline" size="sm" onClick={() => void writeMail()}>
            {t("pages.ideas.writeMail")}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {open && (
          <Button variant="outline" size="sm" onClick={onDiscard}>
            {t("pages.ideas.discard")}
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={onDelete}>
          {t("pages.ideas.delete")}
        </Button>
      </div>
    </div>
  );
}
