import { toastError, errorText } from "@/lib/errorText";
import { WorklogSinkState } from "@/components/issue/WorklogSinkState";
import { OtherFields } from "@/components/issue/OtherFields";
import { ConnectionBadge } from "@/components/app/ConnectionBadge";
import { useEffect, useId, useState, useRef } from "react";
import { Link } from "react-router";
import {
  Bot,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  GitCommitHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { AGENT_LINK_MINUTES } from "@contracts/issueCopy";
import { formatDate, formatDuration, parseDayKey } from "@contracts/time";
import { priorityLabel, priorityTone } from "@/lib/jira";
import { inFloat, isDialogOpen, isTyping } from "@/lib/dom";
import { hotkeySequence } from "@/lib/hotkeySequence";
import { useIssueActions } from "@/hooks/useIssueActions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import {
  LogTimeDialog,
  type EditableWorklog,
} from "@/components/LogTimeDialog";
import { TimerControls, TimerWhere } from "@/components/TimerControls";
import { FavoriteStar } from "@/components/FavoriteStar";
import { StatusBadge } from "@/components/StatusBadge";
import { Chip } from "@/components/app/Chip";
import { IssueTags } from "@/components/issue/IssueTags";
import { MakeTodoButton } from "@/components/todo/MakeTodo";
import { TriageButton } from "@/components/ideas/TriageButton";
import { TodoList } from "@/components/todo/TodoList";
import { useHashFlash } from "@/hooks/useHashFlash";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelSection } from "@/components/app/Panel";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { QuickStatsCard } from "@/components/dashboard/QuickStatsCard";
import { CommentsSection } from "@/components/issue/CommentsSection";
import { PrivateNotesSection } from "@/components/issue/PrivateNotesSection";
import { LinkedNotesSection } from "@/components/issue/LinkedNotesSection";
import { DescriptionSection } from "@/components/issue/DescriptionSection";
import {
  AssigneesEditor,
  EditIssueButton,
  LabelsEditor,
} from "@/components/issue/ManageIssue";
import { useManageable } from "@/hooks/useManageable";
import { AttachmentsSection } from "@/components/issue/AttachmentsSection";
import { RemoteLinks } from "@/components/issue/RemoteLinks";
import { IssueMails } from "@/components/mail/IssueMails";
import { coverClass } from "@/lib/cover";
import { mergeIssueWorklogs } from "@/lib/issueWorklogs";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState } from "@/components/app/States";
import { EstimateLines } from "@/components/issue/IssueEstimate";
import { likelyStat, useIssueEstimate } from "@/components/issue/estimateQuery";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
import { toast } from "sonner";
import { Meter } from "@/components/app/Meter";
import { issueHistory } from "@/lib/issueHistory";
import { PinButton } from "@/components/issue/PinMenu";
import {
  useConnections,
  useKeepsTimeHere,
  useProviderName,
  useTrackerOffers,
} from "@/hooks/useConnections";
import { dateFormat, t } from "@/i18n";
import {
  TransitionDialog,
  type TransitionTarget,
} from "@/components/issue/TransitionDialog";

const dateTime = () =>
  dateFormat({
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** First meaningful line of a Jira description, without wiki markup. */
function descriptionSnippet(text: string | undefined): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map(l =>
      l
        .replace(/\{[a-z]+(:[^}]*)?\}/gi, "")
        .replace(/^h[1-6]\.\s*/i, "")
        .replace(/[*_+]/g, "")
        .replace(/!([^!|]+)(\|[^!]*)?!/g, "")
        .replace(/\[([^|\]]+)\|[^\]]+\]/g, "$1")
        .trim()
    )
    .find(l => l.length > 0);
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-body-sm">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <>
      <div className="flex items-center gap-3 border-b px-5 py-4 md:px-6">
        <Skeleton className="h-8 w-8" />
        <Skeleton className="h-8 w-96 max-w-full" />
      </div>
      <div className="grid gap-3 p-3 md:p-5">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </>
  );
}

export default function IssueDetail({
  issueKey: key,
  connectionId,
}: {
  issueKey: string;
  /** Which connection it is on, when its own link says (a key may be on two) */
  connectionId?: number;
}) {
  const invalidateWorklogs = useInvalidateWorklogs();
  const issue = trpc.issues.get.useQuery({ key, connectionId });
  useHashFlash();
  const provider = useProviderName(issue.data?.connectionId);
  // Only what the issue's tracker can do is offered; time it doesn't keep is counted here.
  const offers = useTrackerOffers(issue.data?.connectionId);
  const timeHere = useKeepsTimeHere(issue.data?.connectionId);
  // "Me" on the issue's tracker: the user's own id on its connection.
  const ownConnection = useConnections().data?.find(
    c => c.id === issue.data?.connectionId
  );

  // Opening the issue reads its news (unread dot, sidebar counter).
  const seenUtils = trpc.useUtils();
  const seen = trpc.issues.markSeen.useMutation({
    onSuccess: () => {
      void seenUtils.issues.all.invalidate();
      void seenUtils.issues.favorites.invalidate();
      void seenUtils.issues.unreadCount.invalidate();
      void seenUtils.issues.list.invalidate();
    },
  });
  const markSeen = seen.mutate;
  // Live from Jira, not in the catalog: nothing local to mark as read.
  const loaded = !!issue.data && !issue.data.remote;
  useEffect(() => {
    if (loaded) markSeen({ key, connectionId });
  }, [loaded, key, connectionId, markSeen]);
  // Its own worklogs: the key on its connection (another tracker may have the same key). When
  // its link names the connection, read at once beside the issue (the same query either way).
  const logsOn = connectionId ?? issue.data?.connectionId;
  const logs = trpc.worklogs.list.useQuery({ issueKey: key, connectionId: logsOn }, { enabled: logsOn !== undefined });
  // Everyone's on its tracker (time kept here is all mine): the others' beside mine.
  const team = trpc.worklogs.team.useQuery(
    { issueKey: key, connectionId: issue.data?.connectionId },
    { enabled: !!issue.data && !timeHere, retry: false }
  );
  // How long it likely takes, from my closed issues: only for an issue in the catalog.
  const estimateQuery = useIssueEstimate(key, issue.data?.connectionId ?? connectionId, loaded);

  const [logOpen, setLogOpen] = useState(false);
  const [editing, setEditing] = useState<EditableWorklog | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [transOpen, setTransOpen] = useState(false);
  // What its tracker lets the app change (GitHub: assignees, labels, title and body).
  const manage = useManageable({ issueKey: key, connectionId });
  // The reason of the last update, next to its date (same query as the dialog).
  const history = trpc.issues.history.useQuery(
    { key, connectionId },
    { retry: false, staleTime: 60_000 }
  );
  const description = trpc.issues.description.useQuery(
    { key, connectionId },
    { retry: false, staleTime: 60_000 }
  );
  const utils = trpc.useUtils();
  // Calls Jira, so only fetch once the user opens the Select. Always fresh:
  // the available transitions depend on the current status.
  const transitions = trpc.issues.transitions.useQuery(
    { key, connectionId },
    { enabled: transOpen, retry: false, staleTime: 0 }
  );
  // A way on that asks for fields (or that inkledger can't take) opens its form.
  const [asking, setAsking] = useState<TransitionTarget | null>(null);
  const transitionDone = async (r: { moved: string; to: string }) => {
    toast.success(`${r.moved} → ${r.to}`);
    // The old list belongs to the previous status: drop it.
    void utils.issues.transitions.reset({ key });
    await Promise.all([
      utils.issues.get.invalidate(),
      utils.issues.list.invalidate(),
      utils.issues.all.invalidate(), utils.issues.favorites.invalidate(),
    ]);
  };
  const transition = trpc.issues.transition.useMutation({
    onSuccess: transitionDone,
    onError: e => toastError(e),
  });

  const importIssue = trpc.issues.import.useMutation({
    onSuccess: async r => {
      toast.success(t("pages.issueDetail.imported", { key: r.imported }));
      await Promise.all([
        utils.issues.get.invalidate({ key }),
        utils.issues.list.invalidate(),
        utils.issues.all.invalidate(), utils.issues.favorites.invalidate(),
        utils.issues.search.invalidate(),
      ]);
    },
    onError: e => toastError(e),
  });

  // Hotkeys: "l" log time, "s" favorite, "h" hide / restore, "c" / "b" / "m" copy
  // key / branch name / commit message.
  const act = useIssueActions();
  // Favorite / hide need the issue in the catalog.
  const flags =
    issue.data && !issue.data.remote
      ? {
          favorite: issue.data.favorite === 1,
          hidden: issue.data.hidden === 1,
          summary: issue.data.summary,
        }
      : null;
  const connection = issue.data?.connectionId;
  // Branch and commit message need only the summary: remote issues too.
  const named = issue.data ? { key, summary: issue.data.summary, issueType: issue.data.issueType } : null;
  const keyRef = useRef({ key, connection, flags, act, named });
  useEffect(() => {
    keyRef.current = { key, connection, flags, act, named };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || isDialogOpen() || inFloat(e.target)) return;
      if (hotkeySequence.pending()) return; // "g b" navigates, it doesn't copy
      const { key: k, connection: c, flags: f, act: a, named: n } = keyRef.current;
      if (e.key === "l") {
        e.preventDefault();
        setLogOpen(true);
      } else if (e.key === "s" && f && !f.hidden) {
        e.preventDefault();
        void a.toggleFavorite(k, c);
      } else if (e.key === "h" && f) {
        e.preventDefault();
        if (f.hidden) void a.restore(k, c);
        else void a.hide(k, c);
      } else if (e.key === "c") {
        e.preventDefault();
        void a.copyKey(k);
      } else if (e.key === "b" && n) {
        e.preventDefault();
        void a.copyBranch(n);
      } else if (e.key === "m" && n) {
        e.preventDefault();
        void a.copyCommit(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const syncLogs = trpc.worklogs.syncIssue.useMutation({
    onSuccess: r => {
      toast.success(t("pages.issueDetail.synced", { count: r.synced }));
      invalidateWorklogs();
    },
    onError: e => toastError(e),
  });
  const del = trpc.worklogs.delete.useMutation({
    onSuccess: () => {
      toast.success(t("pages.issueDetail.worklogDeleted"));
      invalidateWorklogs();
    },
    onError: e => toastError(e),
  });

  if (issue.isPending)
    return (
      <>
        <PageHeader title={key} breadcrumbCurrent={key} back />
        <DetailSkeleton />
      </>
    );
  // A failed background refetch keeps the loaded page (cached data stays): only a
  // first load without data shows a state, and only NOT_FOUND / no row means "not found".
  if (!issue.data) {
    const notFound = !issue.error || issue.error.data?.code === "NOT_FOUND";
    return (
      <>
        <PageHeader title={key} breadcrumbCurrent={key} back />
        {notFound ? (
          <EmptyState
            art="search"
            title={t("pages.issueDetail.notFoundTitle", { key })}
            message={t("pages.issueDetail.notFoundMessage", { provider })}
            action={
              <Button asChild variant="outline">
                <Link to="/issues">{t("pages.issueDetail.backToIssues")}</Link>
              </Button>
            }
            className="py-20"
          />
        ) : (
          <ErrorState
            message={issue.error ? errorText(issue.error) : undefined}
            onRetry={() => issue.refetch()}
            className="py-20"
          />
        )}
      </>
    );
  }

  const i = issue.data;
  const due = i.dueDate ? parseDayKey(i.dueDate) : null;
  const logTotal = logs.data?.reduce((acc, w) => acc + w.timeSpentSeconds, 0);
  // The tracker's total counts everyone: mine first, the team's beside it.
  const teamTotal = timeHere ? null : (team.data?.totalSeconds ?? i.timeSpentSeconds ?? 0);
  // The estimate is the whole issue's: progress on everyone's time.
  const spent = teamTotal ?? logTotal ?? 0;
  const logRows = mergeIssueWorklogs(logs.data ?? [], team.data?.entries);
  // Mine stand out only beside someone else's.
  const withOthers = logRows.some(r => r.kind === "other");
  const estimate = i.timeEstimateSeconds ?? 0;
  // An estimate only where the tracker keeps one and this issue has it.
  const hasEstimate = offers.estimate && i.timeEstimateSeconds != null;
  const pct =
    estimate > 0 ? Math.min(100, Math.round((spent / estimate) * 100)) : null;
  // Fixed header: who and where at a glance, plus the start of the
  // description (same cached query as the Descrizione section).
  const headerLine = [
    i.key,
    i.status,
    !i.assigneeId
      ? t("pages.issueDetail.unassigned")
      : i.assigneeId === ownConnection?.remoteAccountId
        ? t("pages.issueDetail.assignedToYou")
        : (i.assigneeName ?? null),
    descriptionSnippet(description.data?.text),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // The page holds still; its columns scroll (wide screens).
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <PageHeader
        sticky
        title={i.summary}
        description={headerLine}
        documentTitle={i.key}
        breadcrumbCurrent={i.key}
        back
        titleAddon={
          i.remote ? (
            <span className="flex items-center gap-2">
              <span title={t("pages.issueDetail.remoteTitle", { provider })}>
                <Chip>{t("pages.issueDetail.notInCatalog")}</Chip>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={importIssue.isPending}
                onClick={() => importIssue.mutate({ key: i.key, connectionId })}
              >
                <Plus className="h-4 w-4" /> {t("pages.issueDetail.import")}
              </Button>
            </span>
          ) : i.hidden === 1 ? (
            <span className="flex items-center gap-2">
              <Chip>
                <EyeOff className="h-3 w-3" aria-hidden />{" "}
                {t("pages.issueDetail.hidden")}
              </Chip>
              <Button
                variant="outline"
                size="sm"
                onClick={() => act.restore(i.key, i.connectionId)}
              >
                <Eye className="h-4 w-4" /> {t("pages.issueDetail.restore")}
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <FavoriteStar
                issueKey={i.key}
                connectionId={i.connectionId}
                favorite={i.favorite === 1}
              />
              {manage.edit && (
                <EditIssueButton
                  issueKey={i.key}
                  connectionId={i.connectionId}
                  title={i.summary}
                />
              )}
            </span>
          )
        }
        actions={
          <>
            {offers.watch && (
              <Button
                variant={i.watching === 1 ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={i.watching === 1}
                disabled={act.pending}
                title={
                  i.watching === 1
                    ? t("pages.issueDetail.watchingTitle", { provider })
                    : t("pages.issueDetail.watchTitle", { provider })
                }
                onClick={() =>
                  void act.setWatching(i.key, i.watching !== 1, i.connectionId)
                }
              >
                <Eye className="h-4 w-4" />
                {i.watching === 1
                  ? t("pages.issueDetail.watching")
                  : t("pages.issueDetail.watch")}
              </Button>
            )}
            <PinButton issueKey={i.key} connectionId={i.connectionId} />
            <MakeTodoButton label={t("views.todos.onIssueLabel")} initial="" link={{ issueKey: i.key, connectionId: i.connectionId ?? undefined }} />
            {!i.remote && i.connectionId && <TriageButton issueKey={i.key} connectionId={i.connectionId} />}
            <TimerControls issueKey={i.key} connectionId={i.connectionId} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("pages.issueDetail.copyMenu")}
                  title={t("pages.issueDetail.copyTitle")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => void act.copyKey(i.key)}>
                  <Copy className="h-4 w-4" /> {t("pages.issueDetail.copyKey")}
                  <DropdownMenuShortcut>C</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void act.copyBranch(i)}
                >
                  <GitBranch className="h-4 w-4" />{" "}
                  {t("pages.issueDetail.copyBranch")}
                  <DropdownMenuShortcut>B</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void act.copyCommit(i)}>
                  <GitCommitHorizontal className="h-4 w-4" /> {t("pages.issueDetail.copyCommit")}
                  <DropdownMenuShortcut>M</DropdownMenuShortcut>
                </DropdownMenuItem>
                {!i.remote && <CopyForAgent issueKey={i.key} connectionId={i.connectionId ?? undefined} copy={act.copyForAgent} />}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button asChild variant="outline">
              <a href={i.url} target="_blank" rel="noreferrer">
                {t("pages.issueDetail.openInJira", { provider })}
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
            <Button onClick={() => setLogOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("pages.issueDetail.logTime")}
            </Button>
          </>
        }
      />

      {/* Wide: two columns, each scrolling on its own. Narrower: one column in the
          usual order (fields, time, then the issue's text and its time logs). */}
      <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:overflow-hidden" data-scroll-key="issue-page">
        <div className="contents xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto xl:border-r" data-scroll-key="issue-left">
          <PanelSection className="order-1 border-b">
            {/* Project, status and priority in one compact row: no decorative
                cover taking vertical space under the fixed header. */}
            {/* The timer runs on another device (or one gone silent): said here, with what to do. */}
            <TimerWhere issueKey={i.key} connectionId={i.connectionId} className="mb-3" />
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ProjectAvatar
                project={i.projectKey || i.key}
                connectionId={i.connectionId}
                size="md"
                transitionName={`issue-${i.key}`}
              />
              <ConnectionBadge connectionId={i.connectionId} />
              <StatusBadge status={i.status} category={i.category} />
              {i.priority && (
                <Chip variant="dot" tone={priorityTone(i.priority)}>
                  {priorityLabel(i.priority)}
                </Chip>
              )}
            </div>
            <p className="mb-5 text-body-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{i.key}</span>
              {i.projectName ? ` · ${i.projectName}` : ""}
              {i.issueType ? ` · ${i.issueType}` : ""}
            </p>
            <dl className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-6 gap-y-4 sm:grid-cols-3">
              <Detail label={t("pages.issueDetail.project")}>
                {i.projectKey}
                {i.projectName ? ` — ${i.projectName}` : ""}
              </Detail>
              <Detail label={t("pages.issueDetail.transition")}>
                <Select
                  value=""
                  open={transOpen}
                  onOpenChange={setTransOpen}
                  onValueChange={id => {
                    const tr = transitions.data?.find(x => x.id === id);
                    if (tr && (tr.requirements.length > 0 || !tr.executable))
                      setAsking({ transitionId: id });
                    else
                      transition.mutate({ key, connectionId, transitionId: id });
                  }}
                  disabled={transition.isPending}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full max-w-48"
                    aria-label={t("pages.issueDetail.changeStatus")}
                  >
                    <SelectValue
                      placeholder={
                        transition.isPending
                          ? t("pages.issueDetail.changing")
                          : t("pages.issueDetail.changeTo", { status: i.status })
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {transitions.isPending && transOpen ? (
                      <div className="px-2 py-1.5 text-body-sm text-muted-foreground">
                        {t("pages.issueDetail.loading")}
                      </div>
                    ) : transitions.error ? (
                      <div className="px-2 py-1.5 text-body-sm text-danger">
                        {errorText(transitions.error)}
                      </div>
                    ) : transitions.data?.every(
                        tr => tr.toStatus === i.status
                      ) ? (
                      <div className="px-2 py-1.5 text-body-sm text-muted-foreground">
                        {t("pages.issueDetail.noTransitions")}
                      </div>
                    ) : (
                      transitions.data
                        ?.filter(tr => tr.toStatus !== i.status)
                        .map(tr => (
                          <SelectItem key={tr.id} value={tr.id}>
                            {tr.toStatus}
                          </SelectItem>
                        ))
                    )}
                  </SelectContent>
                </Select>
                <TransitionDialog
                  issueKey={key}
                  connectionId={i.connectionId}
                  target={asking}
                  onClose={() => setAsking(null)}
                  onMoved={r => {
                    setAsking(null);
                    transition.reset();
                    void transitionDone(r);
                  }}
                />
              </Detail>
              <Detail label={t("pages.issueDetail.type")}>
                {i.issueType || "—"}
              </Detail>
              <Detail label={t("pages.issueDetail.assignee")}>
                <span className="flex items-center gap-1">
                  {!i.assigneeId
                    ? t("pages.issueDetail.unassignedCap")
                    : i.assigneeId === ownConnection?.remoteAccountId
                      ? t("pages.issueDetail.you")
                      : i.assigneeName || i.assigneeId}
                  {manage.assign && !i.remote && (
                    <AssigneesEditor
                      issueKey={i.key}
                      connectionId={i.connectionId}
                    />
                  )}
                </span>
              </Detail>
              <Detail label={t("pages.issueDetail.reporter")}>
                {i.reporterName || "—"}
              </Detail>
              <Detail label={t("pages.issueDetail.created")}>
                {i.remoteCreatedAt
                  ? dateTime().format(new Date(i.remoteCreatedAt))
                  : "—"}
              </Detail>
              <Detail label={t("pages.issueDetail.updated")}>
                {i.remoteUpdatedAt ? (
                  <button
                    type="button"
                    onClick={() => issueHistory.open(i.key, i.connectionId)}
                    title={t("pages.issueDetail.viewHistory")}
                    className="grid rounded-sm text-left underline decoration-dotted underline-offset-4 outline-none hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {dateTime().format(new Date(i.remoteUpdatedAt))}
                    {history.data?.reason && (
                      <span className="line-clamp-2 [overflow-wrap:anywhere] text-caption text-muted-foreground no-underline">
                        {history.data.reason}
                      </span>
                    )}
                  </button>
                ) : (
                  "—"
                )}
              </Detail>
              <Detail label={t("pages.issueDetail.tags")}>
                <IssueTags
                  labels={i.labels}
                  components={i.components}
                  editor={
                    manage.labels && !i.remote ? (
                      <LabelsEditor
                        issueKey={i.key}
                        connectionId={i.connectionId}
                        labels={i.labels}
                      />
                    ) : undefined
                  }
                />
              </Detail>
            </dl>
          </PanelSection>
          <div className="order-3 min-w-0 border-b xl:border-b-0">
              <PanelSection
                title={t("pages.issueDetail.description")}
                className="border-b"
              >
                <DescriptionSection
                  issueKey={i.key}
                  connectionId={i.connectionId}
                />
              </PanelSection>
              {i.connectionId ? (
                <PanelSection title={t("pages.issueDetail.todos")} className="border-b">
                  <TodoList scope={{ issueKey: i.key, connectionId: i.connectionId }} />
                </PanelSection>
              ) : null}
              <PanelSection
                title={t("pages.issueDetail.privateNotes")}
                className="border-b"
              >
                <PrivateNotesSection
                  issueKey={i.key}
                  connectionId={i.connectionId}
                />
              </PanelSection>
              {i.connectionId && <PanelSection title={t("pages.notes.linkedNotes")} className="border-b"><LinkedNotesSection issueKey={i.key} connectionId={i.connectionId} /></PanelSection>}
              {i.connectionId && (
                <PanelSection title={t("ui.mail.title")} className="border-b">
                  <IssueMails issueKey={i.key} connectionId={i.connectionId} />
                </PanelSection>
              )}
              <PanelSection title={t("pages.issueDetail.comments")}>
                <CommentsSection issueKey={i.key} connectionId={i.connectionId} />
              </PanelSection>
          </div>
        </div>
        <div className="contents xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto" data-scroll-key="issue-right">
          <PanelSection className="order-2 border-b">
            <QuickStatsCard
              title={t("pages.issueDetail.timeOnIssue")}
              cover={coverClass(i.key + "-time")}
              stats={[
                {
                  label: t("pages.issueDetail.myTime"),
                  value: logTotal !== undefined ? formatDuration(logTotal) : "—",
                },
                // No estimate: the number of entries instead.
                hasEstimate
                  ? {
                      label: t("pages.issueDetail.estimate"),
                      value: formatDuration(estimate),
                    }
                  : {
                      label: t("pages.issueDetail.worklogs"),
                      value: String(logRows.length),
                    },
              ]}
              extra={[
                ...[likelyStat(estimateQuery.data)].filter(s => s !== null),
                ...(hasEstimate
                  ? [
                      {
                        label: t("pages.issueDetail.progress"),
                        value: pct !== null ? `${pct}%` : "—",
                      },
                      {
                        label: t("pages.issueDetail.worklogs"),
                        value: String(logRows.length),
                      },
                    ]
                  : []),
                ...(teamTotal === null
                  ? []
                  : [
                      {
                        label: t("pages.issueDetail.teamTotal"),
                        value: formatDuration(teamTotal),
                      },
                    ]),
                {
                  label: t("pages.issueDetail.due"),
                  value: due ? formatDate(due, "long") : "—",
                },
              ]}
            />
            {pct !== null && (
              <Meter
                lit
                value={pct}
                max={100}
                tone={pct >= 100 ? "bg-danger" : "bg-primary"}
                size="md"
                className="mt-4"
              />
            )}
            <EstimateLines query={estimateQuery} trackerEstimate={i.timeEstimateSeconds ?? null} />
          </PanelSection>
          <div className="order-4 min-w-0">
              <PanelSection
                title={t("pages.issueDetail.worklogs")}
                className="border-b"
                actions={
                  !timeHere && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        syncLogs.mutate({
                          issueKey: key,
                          connectionId: i.connectionId,
                        })
                      }
                      disabled={syncLogs.isPending}
                    >
                      <RefreshCw
                        className={cn(
                          "h-4 w-4",
                          syncLogs.isPending && "motion-safe:animate-spin"
                        )}
                      />
                      {t("pages.issueDetail.sync")}
                    </Button>
                  )
                }
              >
                {logs.isPending ? (
                  <div className="grid gap-2">
                    {Array.from({ length: 3 }).map((_, n) => (
                      <Skeleton key={n} className="h-14" />
                    ))}
                  </div>
                ) : logs.error ? (
                  <ErrorState
                    message={errorText(logs.error)}
                    onRetry={() => logs.refetch()}
                  />
                ) : logRows.length === 0 ? (
                  <EmptyState
                    art="inbox"
                    title={t("pages.issueDetail.noWorklogs")}
                    message={t("pages.issueDetail.noWorklogsHint")}
                  />
                ) : (
                  <>
                  {team.error && (
                    <p className="mb-2 text-caption text-muted-foreground">
                      {t("pages.issueDetail.othersUnavailable")}
                    </p>
                  )}
                  <ul className="divide-y" data-testid="issue-worklogs">
                    {logRows.map(row => {
                      if (row.kind === "other") {
                        const e = row.entry;
                        return (
                          <li
                            key={`other-${e.remoteId}`}
                            data-mine="false"
                            className="flex items-start gap-3 border-l-2 border-transparent py-3 pl-3"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="tabular text-muted-foreground">
                                  {formatDuration(e.seconds)}
                                </span>
                                <span className="text-body-sm text-muted-foreground">
                                  {e.authorName || t("pages.issueDetail.someoneElse")}
                                </span>
                              </div>
                              <div className="text-caption text-muted-foreground">
                                {e.start !== null
                                  ? dateTime().format(new Date(e.start))
                                  : e.day
                                    ? formatDate(parseDayKey(e.day) ?? new Date(0), "long")
                                    : "—"}
                              </div>
                              {e.comment && (
                                <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-body-sm text-muted-foreground">
                                  {e.comment}
                                </p>
                              )}
                            </div>
                          </li>
                        );
                      }
                      const w = row.log;
                      const pending = w.remoteId.startsWith("pending-");
                      const started = new Date(w.started);
                      return (
                        <li
                          key={w.id}
                          data-mine="true"
                          className={cn(
                            "flex items-start gap-3 py-3",
                            withOthers && "border-l-2 border-primary bg-primary-soft pl-3"
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="tabular font-medium">
                                {formatDuration(w.timeSpentSeconds)}
                              </span>
                              <span className="text-body-sm font-medium">
                                {t("pages.issueDetail.you")}
                              </span>
                              {pending && (
                                <Chip tone="warning">
                                  {t("pages.issueDetail.queued")}
                                </Chip>
                              )}
                              {!pending && <WorklogSinkState worklogId={w.id} sink={w.sink} provider={provider} />}
                            </div>
                            <div className="text-caption text-muted-foreground">
                              {dateTime().format(started)}
                            </div>
                            {w.comment && (
                              <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-body-sm">
                                {w.comment}
                              </p>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("pages.issueDetail.editWorklog")}
                            disabled={!!w.sink.locked}
                            title={w.sink.locked ? t("views.worklogSink.locked", { provider }) : undefined}
                            onClick={() =>
                              setEditing({
                                id: w.id,
                                connectionId: issue.data?.connectionId,
                                remoteId: w.remoteId,
                                timeSpentSeconds: w.timeSpentSeconds,
                                started: new Date(w.started),
                                comment: w.comment,
                              })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-danger"
                            aria-label={t("pages.issueDetail.deleteWorklog")}
                            disabled={!!w.sink.locked}
                            onClick={() => setDeleting(w.remoteId)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                  </>
                )}
              </PanelSection>
              {offers.attachments && (
                <PanelSection title={t("pages.issueDetail.attachments")}>
                  <AttachmentsSection
                    issueKey={i.key}
                    connectionId={i.connectionId}
                  />
                </PanelSection>
              )}
              <OtherFields issueKey={i.key} connectionId={i.connectionId} />
              <RemoteLinks issueKey={i.key} connectionId={i.connectionId} />
          </div>
        </div>
      </div>

      <LogTimeDialog
        issueKey={key}
        connectionId={issue.data?.connectionId}
        open={logOpen}
        onOpenChange={setLogOpen}
      />
      {editing && (
        <LogTimeDialog
          issueKey={key}
          connectionId={issue.data?.connectionId}
          worklog={editing}
          open
          onOpenChange={o => {
            if (!o) setEditing(null);
          }}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={o => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("pages.issueDetail.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.issueDetail.deleteText", { provider })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("pages.issueDetail.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (deleting)
                  del.mutate({ issueKey: key, remoteId: deleting, connectionId: issue.data?.connectionId });
              }}
            >
              {t("pages.issueDetail.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "Copy for an agent": the issue as Markdown, attachment links open for the chosen time (docs/work/ideas/issue-copy.md). */
function CopyForAgent({ issueKey, connectionId, copy }: { issueKey: string; connectionId: number | undefined; copy: (key: string, connectionId: number | undefined, minutes: number) => Promise<void> }) {
  const prefs = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const fallback = prefs.data?.shareLinkMinutes ?? 60;
  const labelId = useId();
  return (
    // A group, not a submenu: a submenu opens beside the menu and leaves a phone's screen.
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup aria-labelledby={labelId}>
        <DropdownMenuLabel id={labelId} className="flex items-center gap-2">
          <Bot className="h-4 w-4" aria-hidden /> {t("pages.issueDetail.copyForAgent")}
        </DropdownMenuLabel>
        {AGENT_LINK_MINUTES.map(m => {
          const label = t("pages.issueDetail.copyFor", { duration: formatDuration(m * 60) });
          return (
            <DropdownMenuItem key={m} onSelect={() => void copy(issueKey, connectionId, m)}>
              {m === fallback ? t("pages.issueDetail.copyDefault", { duration: label }) : label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuGroup>
    </>
  );
}
