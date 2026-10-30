import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  ChevronLeft,
  ClipboardCopy,
  FileText,
  ListOrdered,
  Mail,
  Plus,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { diaryDayIsEmpty, diaryDays, type DiaryMode } from "@contracts/diary";
import {
  addDays,
  dayKey,
  formatDurationLong,
  parseDayKey,
  startOfDay,
  startOfWeek,
} from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { copyLater, issuePath } from "@/lib/issues";
import { errorText, toastError } from "@/lib/errorText";
import { dateFormat, t } from "@/i18n";
import { PageHeader } from "@/components/app/PageHeader";
import { PeriodNav } from "@/components/app/PeriodNav";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { ErrorState, PageSpinner } from "@/components/app/States";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { newNotePath } from "./paths";

type Span = "week" | "month";

/** The first and last day of the period holding `day`. */
function periodOf(day: Date, span: Span): { from: Date; to: Date } {
  if (span === "week") {
    const from = startOfWeek(day);
    return { from, to: addDays(from, 6) };
  }
  const from = new Date(day.getFullYear(), day.getMonth(), 1);
  return { from, to: new Date(day.getFullYear(), day.getMonth() + 1, 0) };
}

/**
 * The notes as a diary: day by day, what was written (each note on its own
 * day), the time logged per issue, the planned work and the mails pinned.
 * A period can be written up by a model: a report, or a timeline.
 */
export function NoteDiary() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const span: Span = params.get("span") === "month" ? "month" : "week";
  const anchor = parseDayKey(params.get("day") ?? "") ?? startOfDay(new Date());
  const { from, to } = periodOf(anchor, span);
  const fromDay = dayKey(from);
  const toDay = dayKey(to);
  const range = { from: from.toISOString(), to: addDays(to, 1).toISOString() };
  const go = (next: { day?: Date; span?: Span }) =>
    setParams(previous => {
      const p = new URLSearchParams(previous);
      if (next.day) p.set("day", dayKey(next.day));
      if (next.span) p.set("span", next.span);
      return p;
    });
  const step = (dir: 1 | -1) =>
    go({
      day:
        span === "week"
          ? addDays(from, 7 * dir)
          : new Date(from.getFullYear(), from.getMonth() + dir, 1),
    });

  const tree = trpc.notes.tree.useQuery();
  const logs = trpc.worklogs.list.useQuery(range);
  const planned = trpc.planned.list.useQuery(range);
  const mails = trpc.mails.pinnedBetween.useQuery(range);
  const llm = trpc.notes.llm.useQuery();
  const queries = [tree, logs, planned, mails];
  const failed = queries.find(q => q.error);

  const days = diaryDays(fromDay, toDay, {
    notes: (tree.data ?? []).flatMap(n =>
      n.kind === "note" && n.notedOn
        ? [{ id: n.id, title: n.title, notedOn: n.notedOn }]
        : []
    ),
    worklogs: (logs.data ?? []).map(w => ({
      issueKey: w.issueKey,
      seconds: w.timeSpentSeconds,
      started: new Date(w.started),
      comment: w.comment,
    })),
    planned: (planned.data ?? []).map(p => ({
      kind: p.kind,
      startsAt: new Date(p.startsAt),
      endsAt: new Date(p.endsAt),
      issueKey: p.issueKey,
      note: p.note,
    })),
    mails: (mails.data ?? []).map(m => ({
      subject: m.subject,
      fromName: m.fromName,
      pinnedAt: new Date(m.pinnedAt),
      issueKey: m.issueKey,
    })),
  });

  const utils = trpc.useUtils();
  const [writing, setWriting] = useState<DiaryMode | null>(null);
  const summarize = trpc.notes.summarize.useMutation();
  const write = async (mode: DiaryMode) => {
    setWriting(mode);
    try {
      const made = await summarize.mutateAsync({
        fromDay,
        toDay,
        ...range,
        mode,
      });
      const note = await utils.client.notes.create.mutate({
        title: made.title,
        body: made.markdown,
        notedOn: toDay,
      });
      void utils.notes.tree.invalidate();
      toast.success(
        t(
          made.cut
            ? "pages.notes.diary.writtenCut"
            : "pages.notes.diary.written"
        )
      );
      void navigate(`/notes/${note.id}`);
    } catch (e) {
      toastError(e);
    } finally {
      setWriting(null);
    }
  };
  const copyForModel = async (mode: DiaryMode) => {
    const made = utils.client.notes.diaryPrompt.mutate({
      fromDay,
      toDay,
      ...range,
      mode,
    });
    const copied = await copyLater(made.then(r => r.prompt));
    try {
      await made;
      if (copied) toast.success(t("pages.notes.diary.copied"));
      else toast.error(t("ui.issueActions.copyFailed"));
    } catch (e) {
      toastError(e);
    }
  };

  const weekday = dateFormat({
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const periodTitle = dateFormat({
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const today = dayKey(new Date());
  const empty = days.every(diaryDayIsEmpty);

  return (
    <div>
      <PageHeader
        title={t("pages.notes.diary.title")}
        description={t("pages.notes.diary.description", {
          from: periodTitle.format(from),
          to: periodTitle.format(to),
        })}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/notes">
                <ChevronLeft />
                {t("pages.notes.backToNotes")}
              </Link>
            </Button>
            <SegmentedControl
              label={t("pages.notes.diary.span")}
              value={span}
              onChange={value => go({ span: value })}
              options={[
                { value: "week", label: t("pages.notes.diary.week") },
                { value: "month", label: t("pages.notes.diary.month") },
              ]}
            />
            <PeriodNav
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onToday={() => go({ day: new Date() })}
              isCurrent={fromDay <= today && today <= toDay}
            />
          </>
        }
      />
      {/* What a model writes from these days: a report or a timeline, saved as a note. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3 md:px-6">
        {llm.data?.available && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!!writing || empty}
              onClick={() => void write("summary")}
            >
              <Sparkles />
              {t("pages.notes.diary.summary")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!writing || empty}
              onClick={() => void write("timeline")}
            >
              <ListOrdered />
              {t("pages.notes.diary.timeline")}
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={empty}>
              <ClipboardCopy />
              {t("pages.notes.diary.copyForModel")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => void copyForModel("summary")}>
              {t("pages.notes.diary.copySummary")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyForModel("timeline")}>
              {t("pages.notes.diary.copyTimeline")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {writing && (
          <p role="status" className="text-caption text-muted-foreground">
            {t("pages.notes.diary.writing")}
          </p>
        )}
      </div>
      {failed ? (
        <ErrorState
          message={errorText(failed.error)}
          onRetry={() => queries.forEach(q => void q.refetch())}
        />
      ) : queries.some(q => q.isPending) ? (
        <PageSpinner />
      ) : (
        <ol
          className="grid grid-cols-[minmax(0,1fr)] divide-y"
          aria-label={t("pages.notes.diary.days")}
        >
          {days.map(d => {
            const date = parseDayKey(d.day) ?? from;
            const quiet = diaryDayIsEmpty(d);
            return (
              <li
                key={d.day}
                className={
                  quiet
                    ? "px-5 py-2 md:px-6"
                    : "grid min-w-0 gap-3 px-5 py-4 md:px-6"
                }
                aria-label={weekday.format(date)}
              >
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <h2
                    className={
                      quiet
                        ? "text-body-sm text-muted-foreground"
                        : "font-display text-body font-semibold"
                    }
                  >
                    {weekday.format(date)}
                    {d.day === today && (
                      <Chip className="ml-2">{t("common.today")}</Chip>
                    )}
                  </h2>
                  <div className="flex items-center gap-2">
                    {d.loggedSeconds > 0 && (
                      <span className="text-caption text-muted-foreground tabular">
                        {formatDurationLong(d.loggedSeconds)}
                      </span>
                    )}
                    <Button asChild size="sm" variant="ghost">
                      <Link
                        to={newNotePath(null, null, d.day)}
                        aria-label={t("pages.notes.diary.noteFor", {
                          day: weekday.format(date),
                        })}
                      >
                        <Plus />
                        {t("pages.notes.diary.note")}
                      </Link>
                    </Button>
                  </div>
                </div>
                {!quiet && (
                  <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                    <div className="grid min-w-0 content-start gap-1.5">
                      {d.notes.map(n => (
                        <Link
                          key={n.id}
                          to={`/notes/${n.id}`}
                          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-body-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <FileText
                            aria-hidden
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                          />
                          <span className="truncate font-medium">
                            {n.title || t("pages.notes.untitled")}
                          </span>
                        </Link>
                      ))}
                      {d.mails.map((m, i) => (
                        <p
                          key={`m${i}`}
                          className="flex min-w-0 items-center gap-2 px-1 text-body-sm text-muted-foreground"
                        >
                          <Mail aria-hidden className="h-4 w-4 shrink-0" />
                          <span className="truncate">
                            {m.subject || t("pages.notes.diary.noSubject")}
                          </span>
                          {m.issueKey && (
                            <Chip className="shrink-0">{m.issueKey}</Chip>
                          )}
                        </p>
                      ))}
                      {d.planned.map((p, i) => (
                        <p
                          key={`p${i}`}
                          className="px-1 text-caption text-muted-foreground [overflow-wrap:anywhere]"
                        >
                          {t("pages.notes.diary.planned", {
                            kind: p.kind,
                            issue: p.issueKey ?? "",
                          })}
                          {p.note ? ` · ${p.note}` : ""}
                        </p>
                      ))}
                    </div>
                    {d.issues.length > 0 && (
                      <ul
                        className="grid min-w-0 content-start gap-1"
                        aria-label={t("pages.notes.diary.logged")}
                      >
                        {d.issues.map(i => (
                          <li
                            key={i.issueKey}
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 text-body-sm"
                          >
                            <Link
                              to={issuePath({ key: i.issueKey })}
                              className="truncate font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {i.issueKey}
                            </Link>
                            <span className="text-muted-foreground tabular">
                              {formatDurationLong(i.seconds)}
                            </span>
                            {i.comments.length > 0 && (
                              <span className="col-span-2 text-caption text-muted-foreground [overflow-wrap:anywhere]">
                                {i.comments.join(" · ")}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
