import { errorText } from "@/lib/errorText";
import { priorityLabel, priorityTone } from "@/lib/jira";
import { issueHistory } from "@/lib/issueHistory";
import { ConnectionBadge } from "@/components/app/ConnectionBadge";
import { PanelSection } from "@/components/app/Panel";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Chip } from "@/components/app/Chip";
import { StatusBadge } from "@/components/StatusBadge";
import { TimerWhere } from "@/components/TimerControls";
import { IssueTags } from "@/components/issue/IssueTags";
import { AssigneesEditor, LabelsEditor } from "@/components/issue/ManageIssue";
import { TransitionDialog } from "@/components/issue/TransitionDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIssueTransitions, type Issue, type IssueData } from "@/components/issue/useIssueData";
import { dateTime } from "@/components/issue/issueFormat";
import { t } from "@/i18n";

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

/** The issue's fields: where it is, its status (with the way on), who, when and its tags. */
export function IssueFields({
  issue: i,
  issueKey: key,
  connectionId,
  data: { ownConnection, manage, history },
  gridClassName,
  transitionName,
  headless = false,
}: {
  issue: Issue;
  /** The key it was opened by (moves and their form act on it). */
  issueKey: string;
  connectionId: number | undefined;
  data: IssueData;
  /** The fields' grid: its columns follow the page's or the pane's width. */
  gridClassName: string;
  /** The project picture's view transition (one per document: the page only). */
  transitionName?: string;
  /** A desk's pane: its header shows the picture, key, status and priority; here not again. */
  headless?: boolean;
}) {
  const { transOpen, setTransOpen, transitions, asking, setAsking, transitionDone, transition } =
    useIssueTransitions(key, connectionId);
  return (
    <PanelSection className="order-1 border-b">
      {/* Project, status and priority in one compact row: no decorative
          cover taking vertical space under the fixed header. */}
      {/* The timer runs on another device (or one gone silent): said here, with what to do. */}
      <TimerWhere issueKey={i.key} connectionId={i.connectionId} className="mb-3" />
      {headless ? null : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ProjectAvatar
              project={i.projectKey || i.key}
              connectionId={i.connectionId}
              size="md"
              transitionName={transitionName}
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
        </>
      )}
      <dl className={gridClassName}>
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
                    : headless
                    ? t("pages.issueDetail.changeStatus")
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
  );
}
