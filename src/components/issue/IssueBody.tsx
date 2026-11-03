import { useMediaQuery } from "@/hooks/useMediaQuery";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { surface } from "@/components/app/surface";
import { TimerControls } from "@/components/TimerControls";
import { useStartTimer } from "@/hooks/useStartTimer";
import { useRef, useState, type ReactNode } from "react";
import type { DeskPane } from "@contracts/desk";
import { Link } from "react-router";
import { errorText } from "@/lib/errorText";
import { issueId } from "@/lib/issues";
import { mergeIssueWorklogs } from "@/lib/issueWorklogs";
import { useIssueActions } from "@/hooks/useIssueActions";
import { useHashFlash } from "@/hooks/useHashFlash";
import { useShownOnce } from "@/hooks/useShownOnce";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState, ErrorState } from "@/components/app/States";
import { StatusBadge } from "@/components/StatusBadge";
import { LogTimeDialog } from "@/components/LogTimeDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IssueActions, IssueTitleAddon } from "@/components/issue/IssueActions";
import { IssueFields } from "@/components/issue/IssueFields";
import { IssueTimeCard } from "@/components/issue/IssueTimeCard";
import { IssueWorklogs } from "@/components/issue/IssueWorklogs";
import { IssueAttachedSections, IssueTextSections } from "@/components/issue/IssueTextSections";
import { usePaneSize, type PaneSize } from "@/components/issue/paneSize";
import { useIssueData, type Issue, type IssueData } from "@/components/issue/useIssueData";
import { useIssueHotkeys } from "@/components/issue/useIssueHotkeys";
import { SendToDeskButton, TitleGrip } from "@/components/desk/SendToDesk";
import { useDeskKeys, useLongPress } from "@/lib/desk/useSendToDesk";
import { t } from "@/i18n";

type Variant = "page" | "pane";

const PANE_SIZES: readonly PaneSize[] = ["s", "m", "l"];

/**
 * Where each part goes. The page: wide, two columns each scrolling on its own;
 * narrower, one column in the usual order (fields, time, then the issue's text and
 * its time logs). A pane: the same by the pane's own width (data-pane-size on its
 * root), in one scroller.
 */
const LAYOUT = {
  page: {
    columns: "flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:overflow-hidden",
    left: "contents xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto xl:border-r",
    right: "contents xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto",
    // Below xl one column: the worklogs (order-3) come before the text sections, not after every comment.
    text: "order-4 min-w-0 border-b xl:border-b-0",
    fields: "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-6 gap-y-4 sm:grid-cols-3",
  },
  pane: {
    columns: "flex flex-col group-data-[pane-size=l]/pane:grid group-data-[pane-size=l]/pane:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]",
    left: "contents group-data-[pane-size=l]/pane:flex group-data-[pane-size=l]/pane:flex-col group-data-[pane-size=l]/pane:border-r",
    right: "contents group-data-[pane-size=l]/pane:flex group-data-[pane-size=l]/pane:flex-col",
    text: "order-4 min-w-0 border-b group-data-[pane-size=l]/pane:border-b-0",
    fields: "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-6 gap-y-4 group-data-[pane-size=m]/pane:grid-cols-3 group-data-[pane-size=l]/pane:grid-cols-3",
  },
} satisfies Record<Variant, Record<string, string>>;

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

/**
 * An issue: its fields, time, text and worklogs. `page` is the issue's own page (header,
 * tab title, #comment links, hotkeys); `pane` is one issue among others on a desk: a slim
 * `header`, one scroller, a layout by its own width, heavy sections mounted on the way,
 * hotkeys only while `active`, read (unread dot) once it is first shown.
 */
export function IssueBody(props: {
  issueKey: string;
  /** Which connection it is on, when its own link says (a key may be on two) */
  connectionId?: number;
  variant: Variant;
  /** A pane: the one the keyboard talks to. */
  active?: boolean;
  /** A pane: the widest layout it takes (a pane beside others stays in one column). */
  maxSize?: PaneSize;
  /** A pane: its scroller's key (`${prefix}-${issueId}`) for scroll restoration. */
  scrollKeyPrefix?: string;
  /**
   * A pane: in place of its own slim header (key, title, status, actions), drawn from the
   * issue as loaded (none yet while loading or when missing: the key alone is known).
   */
  header?: (pane: PaneHeaderProps) => ReactNode;
}) {
  return props.variant === "page" ? <PageBody {...props} /> : <PaneBody {...props} />;
}

type BodyProps = Parameters<typeof IssueBody>[0];

/** What a pane's own header draws from. */
export type PaneHeaderProps = {
  issue: Issue | undefined;
  data: IssueData;
  act: ReturnType<typeof useIssueActions>;
  connectionId: number | undefined;
  onLogTime: () => void;
};

function PageBody({ issueKey: key, connectionId }: BodyProps) {
  useHashFlash();
  const body = useBody({ issueKey: key, connectionId, variant: "page", markSeen: true, hotkeys: true });
  const { data, act } = body;
  const { issue } = data;
  // The bottom bar is a phone's (and a tablet's): mounted only there, or its ticking timer would redraw
  // on a laptop for nothing (e2e/renders budgets).
  const phone = useMediaQuery("(max-width: 1023px)", false);
  // To the Desk: the grip by the title (dragged to an edge), the Layout button, Alt+Shift+arrows, a long press on a phone.
  const [sendOpen, setSendOpen] = useState(false);
  const onConnection = issue.data?.connectionId ?? connectionId;
  const deskPane: DeskPane | null = issue.data && onConnection ? { connectionId: onConnection, key: issue.data.key, remoteId: issue.data.remoteId ?? null } : null;
  useDeskKeys(deskPane);
  const longPress = useLongPress(() => setSendOpen(true));

  if (issue.isPending)
    return (
      <>
        <PageHeader title={key} breadcrumbCurrent={key} back />
        <DetailSkeleton />
      </>
    );
  if (!issue.data)
    return (
      <>
        <PageHeader title={key} breadcrumbCurrent={key} back />
        <Missing issueKey={key} body={body} />
      </>
    );

  const i = issue.data;
  // Fixed header: what the issue is (key, type, project). Its status and assignee are in its fields and
  // its text in Description, each once (docs/design-system.md §7.1, one datum one place).
  const headerLine = [i.key, i.issueType, i.projectName]
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
        titleLead={deskPane && <TitleGrip pane={deskPane} />}
        titleProps={deskPane ? longPress : undefined}
        // A long press on a phone opens the desk's layouts, not the text's own menu.
        titleClassName="coarse:select-none coarse:[-webkit-touch-callout:none]"
        titleAddon={<IssueTitleAddon issue={i} data={data} connectionId={connectionId} act={act} />}
        addonInline
        actions={
          <IssueActions
            issue={i}
            data={data}
            connectionId={connectionId}
            act={act}
            onLogTime={body.openLog}
            deskButton={deskPane && <SendToDeskButton pane={deskPane} open={sendOpen} onOpenChange={setSendOpen} />}
          />
        }
      />
      <Columns issue={i} body={body} scrollKeys={{ columns: "issue-page", left: "issue-left", right: "issue-right" }} />
      {/* A phone: the issue's two daily actions at the bottom, above the tab bar, where the thumb is
          (Hoober; Material's bottom app bar). The page keeps room for it. */}
      {phone && <div aria-hidden className="h-16" />}
      {phone && createPortal(
      // On the body: the page's entry animation (a transform) would otherwise hold it in the page.
      <div
        data-chrome="bottom"
        role="group"
        aria-label={t("pages.issueDetail.actionsBar")}
        {...surface("ground")}
        className="fixed inset-x-0 bottom-[calc(var(--bottom-nav-h,0px)+var(--dock-h,0px))] z-20 flex items-center justify-between gap-2 border-t bg-card px-4 py-2 lg:hidden"
      >
        <TimerControls issueKey={i.key} connectionId={i.connectionId} />
        <Button onClick={body.openLog}>
          <Plus className="h-4 w-4" />
          {t("pages.issueDetail.logTime")}
        </Button>
      </div>,
      document.body
      )}
      {body.logDialog}
    </div>
  );
}

function PaneBody({ issueKey: key, connectionId, active = false, maxSize = "l", scrollKeyPrefix = "pane", header }: BodyProps) {
  const root = useRef<HTMLDivElement>(null);
  const measured = usePaneSize(root);
  const size = PANE_SIZES.indexOf(measured) > PANE_SIZES.indexOf(maxSize) ? maxSize : measured;
  // Read (unread dot) once it is first on screen, not while parked out of sight.
  const shown = useShownOnce(root);
  const body = useBody({ issueKey: key, connectionId, variant: "pane", markSeen: shown, hotkeys: active });
  const { data, act } = body;
  const i = data.issue.data;
  return (
    <div
      ref={root}
      data-pane-size={size}
      data-scroll-key={`${scrollKeyPrefix}-${issueId({ key, connectionId: i?.connectionId ?? connectionId })}`}
      className="group/pane flex h-full min-h-0 min-w-0 flex-col overflow-y-auto"
    >
      {header?.({ issue: i, data, act, connectionId, onLogTime: body.openLog })}
      {data.issue.isPending ? (
        <DetailSkeleton />
      ) : !i ? (
        <Missing issueKey={key} body={body} />
      ) : (
        <>
          {!header && (
            // surface: none — the pane's own title row, on the pane's panel like the page header.
            <div className="sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-caption text-muted-foreground">{i.key}</p>
                <h2 className="truncate text-body-sm font-semibold">{i.summary}</h2>
              </div>
              <StatusBadge status={i.status} category={i.category} />
              <IssueActions issue={i} data={data} connectionId={connectionId} act={act} onLogTime={body.openLog} compact />
            </div>
          )}
          <Columns issue={i} body={body} lazy idScope={`${i.connectionId ?? connectionId ?? 0}-`} />
          {body.logDialog}
        </>
      )}
    </div>
  );
}

type Body = ReturnType<typeof useBody>;

/** The issue's data, its actions, the Log time dialog and its hotkeys. */
function useBody({
  issueKey: key,
  connectionId,
  variant,
  markSeen,
  hotkeys,
}: {
  issueKey: string;
  connectionId: number | undefined;
  variant: Variant;
  markSeen: boolean;
  hotkeys: boolean;
}) {
  const data = useIssueData({ issueKey: key, connectionId, markSeen });
  const [logOpen, setLogOpen] = useState(false);
  const act = useIssueActions();
  const i = data.issue.data;
  const startTimer = useStartTimer({ announce: true });
  useIssueHotkeys({
    enabled: hotkeys,
    issueKey: key,
    connectionId: i?.connectionId,
    flags: i && !i.remote ? { favorite: i.favorite === 1, hidden: i.hidden === 1, summary: i.summary } : null,
    named: i ? { key, summary: i.summary, issueType: i.issueType } : null,
    act,
    onLogTime: () => setLogOpen(true),
    onStartTimer: i ? () => startTimer.mutate({ issueKey: key, connectionId: i.connectionId ?? undefined }) : undefined,
  });
  const logDialog = (
    <LogTimeDialog
      issueKey={key}
      connectionId={i?.connectionId}
      open={logOpen}
      onOpenChange={setLogOpen}
    />
  );
  return { issueKey: key, connectionId, variant, data, act, openLog: () => setLogOpen(true), logDialog };
}

/** Not found (or not readable): what to do next, or Retry. */
function Missing({ issueKey: key, body: { data: { issue, provider }, variant } }: { issueKey: string; body: Body }) {
  // A failed background refetch keeps the loaded page (cached data stays): only a
  // first load without data shows a state, and only NOT_FOUND / no row means "not found".
  const notFound = !issue.error || issue.error.data?.code === "NOT_FOUND";
  const className = variant === "page" ? "py-20" : "py-10";
  return notFound ? (
    <EmptyState
      art="search"
      title={t("pages.issueDetail.notFoundTitle", { key })}
      message={t("pages.issueDetail.notFoundMessage", { provider })}
      action={
        variant === "page" ? (
          <Button asChild variant="outline">
            <Link to="/issues">{t("pages.issueDetail.backToIssues")}</Link>
          </Button>
        ) : undefined
      }
      className={className}
    />
  ) : (
    <ErrorState
      message={issue.error ? errorText(issue.error) : undefined}
      onRetry={() => issue.refetch()}
      className={className}
    />
  );
}

/** The issue's parts in their two columns (or one, in order). */
function Columns({
  issue: i,
  body: { issueKey: key, connectionId, variant, data },
  scrollKeys,
  lazy = false,
  idScope,
}: {
  issue: Issue;
  body: Body;
  /** The page's scrollers (a pane has one, its own root). */
  scrollKeys?: { columns: string; left: string; right: string };
  lazy?: boolean;
  idScope?: string;
}) {
  const layout = LAYOUT[variant];
  const logRows = mergeIssueWorklogs(data.logs.data ?? [], data.team.data?.entries);
  const logTotal = data.logs.data?.reduce((acc, w) => acc + w.timeSpentSeconds, 0);
  return (
    <div className={layout.columns} data-scroll-key={scrollKeys?.columns}>
      <div className={layout.left} data-scroll-key={scrollKeys?.left}>
        <IssueFields
          issue={i}
          issueKey={key}
          connectionId={connectionId}
          data={data}
          gridClassName={layout.fields}
          // A pane's header already names it (picture, key, status): not again here.
          headless={variant === "pane"}
          // One view transition name per document: the page's alone.
          transitionName={variant === "page" ? `issue-${i.key}` : undefined}
        />
        <IssueTextSections issue={i} className={layout.text} lazy={lazy} idScope={idScope} />
      </div>
      <div className={layout.right} data-scroll-key={scrollKeys?.right}>
        <IssueTimeCard issue={i} data={data} logTotal={logTotal} logCount={logRows.length} />
        <div className="order-3 min-w-0">
          <IssueWorklogs issue={i} issueKey={key} data={data} logRows={logRows} />
          <IssueAttachedSections issue={i} data={data} lazy={lazy} />
        </div>
      </div>
    </div>
  );
}
