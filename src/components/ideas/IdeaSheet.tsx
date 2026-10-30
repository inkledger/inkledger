import { useState } from "react";
import { X } from "lucide-react";
import type { Criterion, IdeaRoute, Question } from "@contracts/ideas";
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
export function IdeaSheet({ ideaId, onClose, onDiscard, onDelete }: { ideaId: number | null; onClose: () => void; onDiscard: (idea: Idea) => void; onDelete: (idea: Idea) => void }) {
  const open = ideaId !== null;
  const idea = trpc.ideas.get.useQuery({ id: ideaId ?? 0 }, { enabled: open });
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
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
          <IdeaFields key={idea.data.id} idea={idea.data} onDiscard={() => idea.data && onDiscard(idea.data)} onDelete={() => idea.data && onDelete(idea.data)} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function IdeaFields({ idea, onDiscard, onDelete }: { idea: Idea; onDiscard: () => void; onDelete: () => void }) {
  const utils = trpc.useUtils();
  const projects = trpc.ideas.projects.useQuery(undefined, { staleTime: 5 * 60_000 });
  const update = trpc.ideas.update.useMutation({
    onSuccess: saved => utils.ideas.get.setData({ id: idea.id }, saved),
    onError: e => toastError(e),
    onSettled: () => void utils.ideas.list.invalidate(),
  });
  const save = (patch: Omit<Parameters<typeof update.mutate>[0], "id">) => update.mutate({ id: idea.id, ...patch });
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  const [criterion, setCriterion] = useState("");
  const [question, setQuestion] = useState("");
  const setAcceptance = (acceptance: Criterion[]) => save({ acceptance });
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

      <div className="flex flex-wrap gap-2 border-t pt-4">
        {idea.state !== "discarded" && idea.state !== "promoted" && (
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
