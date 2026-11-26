import { useDeferredValue, useEffect, useRef, useState, type CSSProperties } from "react";
import { NavigationType, useLocation, useNavigate, useNavigationType } from "react-router";
import { ArrowUpRight, BellOff, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Mail, MailOpen, Play, RotateCcw } from "lucide-react";
import {
  INBOX_STATES,
  NOTIFICATION_CATEGORIES,
  categoryCounts,
  groupByIssue,
  groupSummary,
  inCategory,
  inState,
  nextAfter,
  type InboxGroup,
  type InboxState,
  type NotificationCategory,
} from "@contracts/notificationGroups";
import { PageHeader, SectionLabel } from "@/components/app/PageHeader";
import { PageToolbar } from "@/components/app/PageToolbar";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Splitter } from "@/components/app/Splitter";
import { Toolbar } from "@/components/app/Toolbar";
import { EmptyState, ErrorState } from "@/components/app/States";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { surface } from "@/components/app/surface";
import { IssueBody } from "@/components/issue/IssueBody";
import { IssueActions } from "@/components/issue/IssueActions";
import { StatusBadge } from "@/components/StatusBadge";
import { AlertList } from "@/components/notifications/AlertList";
import { NotificationEvents } from "@/components/notifications/NotificationEvents";
import { Kbd } from "@/components/app/Kbd";
import { KIND_STYLE, ago, reason } from "@/components/notifications/notificationKinds";
import { TodoReminders } from "@/components/todo/TodoReminders";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useInbox, type InboxRow } from "@/hooks/useInbox";
import { useListKeyboard } from "@/hooks/useListKeyboard";
import { useStartTimer } from "@/hooks/useStartTimer";
import { useUrlFields } from "@/hooks/useUrlState";
import { errorText } from "@/lib/errorText";
import { issuePath } from "@/lib/issues";
import { formatWidth, parseWidth, splitBounds } from "@/lib/layout/split";
import { regionSize } from "@/lib/layout/regions";
import { projectOf } from "@/lib/projectColors";
import { deviceSetting } from "@/lib/storage";
import { flag, oneOf, text, textSet, type Fields } from "@/lib/urlCodecs";
import { createStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type View = { cat: NotificationCategory; state: InboxState; sel: string; open: Set<string>; detail: boolean };

/**
 * What the page keeps in the URL: Back from an issue (or from the detail on a narrow screen) finds the
 * category, the state, the selected group and the groups opened as they were; the scroll is the shell's.
 */
const FIELDS: Fields<View> = {
  cat: { key: "cat", fallback: "all", codec: oneOf(NOTIFICATION_CATEGORIES) },
  state: { key: "state", fallback: "unread", codec: oneOf(INBOX_STATES) },
  sel: { key: "sel", fallback: "", codec: text },
  open: { key: "open", fallback: new Set<string>(), codec: textSet },
  detail: { key: "detail", fallback: false, codec: flag },
};

/** The preview's width beside the list (px; null: the default 28rem), kept on this device like the Issues one. */
const previewWidth = deviceSetting("ikl-notifications-preview-width", parseWidth, formatWidth);
const previewBounds = (container: number) => splitBounds({ container, viewport: window.innerWidth, paneMin: 360, mainMin: 420, viewportShare: 0.6 });

/**
 * Groups read while looked at under "Unread" stay in place until the filter changes (no row leaves from
 * under the pointer), across a visit to the issue and Back too: kept for the page's session, per filter.
 */
/** The group the detail showed when its Back was pressed: the list it returns to selects it (next / previous moved on). */
const selectAfterBack = createStore<string | null>(null);

const keptRead = createStore<{ filter: string; keys: ReadonlySet<string> }>({ filter: "", keys: new Set() });

type Group = InboxGroup<InboxRow>;

export default function NotificationsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [view, setView] = useUrlFields(FIELDS);
  const { cat, state, sel, open, detail } = view;
  const inbox = useInbox({ done: state === "done" });
  const start = useStartTimer({ announce: true });

  const filter = `${cat}|${state}`;
  // A visit that is not Back / Forward starts afresh: groups read last time are no longer held under Unread.
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType !== NavigationType.Pop) keptRead.set({ filter: "", keys: new Set() });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the page is opened
  }, []);
  const held = keptRead.use();
  const kept = held.filter === filter ? held.keys : new Set<string>();
  const keep = (...add: string[]) => {
    const now = keptRead.get();
    keptRead.set({ filter, keys: new Set([...(now.filter === filter ? now.keys : []), ...add]) });
  };
  // The selected group never leaves the list under the pointer either.
  const shownRows = inState(inbox.rows, state, sel ? new Set([...kept, sel]) : kept);
  const counts = categoryCounts(shownRows);
  const groups = groupByIssue(inCategory(shownRows, cat));
  const keys = groups.map(g => g.key);
  const selected = keys.includes(sel) ? sel : null;
  const byKey = (key: string | null) => groups.find(g => g.key === key) ?? null;
  const openRows = inbox.open.data ?? [];
  const unreadTotal = openRows.filter(n => n.readAt === null).length;
  const readTotal = inState(openRows, "read").length;

  const regionRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const width = previewWidth.use();
  // List and preview side by side from a wide region (@xl): a choice reads beside the list, no new history
  // entry. Narrower, the detail replaces the list, and the page's filters and bulk actions make room for it.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(regionSize(el.clientWidth, parseFloat(getComputedStyle(document.documentElement).fontSize)) === "xl"));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const split = () => wide;
  const previewShown = () => previewRef.current?.offsetParent != null;

  const select = (key: string | null, how: "click" | "keys" = "keys") => {
    if (key === null) setView({ sel: "" });
    // Narrower, a click opens the detail over the list: an entry of its own, so Back returns to the list where it was.
    else if (how === "click" && !split()) setView({ sel: key, detail: true }, { push: true });
    else setView({ sel: key });
  };
  /** Back to the list: through the history when the detail was opened from it (scroll and all), else in place. */
  const backToList = () => {
    if (location.key === "default") {
      setView({ detail: false });
      return;
    }
    selectAfterBack.set(selected);
    void navigate(-1);
  };
  useEffect(() => {
    const key = selectAfterBack.get();
    if (key === null || detail) return;
    selectAfterBack.set(null);
    if (key !== sel) setView({ sel: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per history entry: the one Back landed on
  }, [location.key]);
  /** `key` leaves the list (done, unread under "Read"): the selection goes to the next one, asked before it leaves. */
  const moveOn = (key: string) => {
    const next = nextAfter(keys, key);
    if (next) setView({ sel: next });
    else if (detail && !split()) backToList();
    else setView({ sel: "" });
  };

  // Opened = read (in the app only), once it is on screen: the preview beside the list, or the detail.
  const unreadAgain = useRef<string | null>(null);
  const shown = useDeferredValue(selected);
  const latest = useRef({ byKey, keep, setRead: inbox.setRead, state });
  useEffect(() => {
    latest.current = { byKey, keep, setRead: inbox.setRead, state };
  });
  const loaded = inbox.open.isSuccess;
  useEffect(() => {
    if (!shown || !loaded || !previewShown()) return;
    if (unreadAgain.current === shown) return;
    unreadAgain.current = null;
    const { byKey: find, keep: hold, setRead, state: now } = latest.current;
    if (now === "done") return;
    const ids = (find(shown)?.items ?? []).filter(n => n.readAt === null).map(n => n.id);
    if (ids.length === 0) return;
    hold(shown);
    setRead(ids, true);
  }, [shown, loaded, detail]);

  const toggleRead = (key: string) => {
    const g = byKey(key);
    if (!g || state === "done") return;
    if (g.unread > 0) {
      keep(key);
      inbox.setRead(g.items.filter(n => n.readAt === null).map(n => n.id), true);
      return;
    }
    // Unread again: not read back at once because it is still on screen.
    unreadAgain.current = key;
    if (state === "read") moveOn(key);
    inbox.setRead(g.items.map(n => n.id), false);
  };
  const finish = (key: string) => {
    const g = byKey(key);
    if (!g) return;
    moveOn(key);
    if (state === "done") inbox.restore(g.items.map(n => n.id));
    else inbox.done(g.items.map(n => n.id));
  };
  const openIssue = (key: string) => {
    const g = byKey(key);
    if (g) void navigate(issuePath({ key: g.issueKey, connectionId: g.connectionId }));
  };
  const toggleOpen = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setView({ open: next });
  };

  useListKeyboard(
    keys,
    {
      open: openIssue,
      e: finish,
      u: toggleRead,
      escape: () => (detail && !split() ? backToList() : select(null)),
      t: key => {
        const g = byKey(key);
        if (g) start.mutate({ issueKey: g.issueKey, connectionId: g.connectionId });
      },
    },
    { selected, onSelect: key => select(key) }
  );

  const current = byKey(selected);
  // The detail over the list (narrow), when there is one to show: a selection gone (done elsewhere, Forward
  // after Done) shows the list instead of an empty page.
  const reading = detail && !wide && current !== null;
  const at = selected ? keys.indexOf(selected) : -1;
  const visibleIds = groups.flatMap(g => g.items.map(n => n.id));
  const visibleUnread = groups.flatMap(g => g.items.filter(n => n.readAt === null).map(n => n.id));

  // Read where they are: under "Unread" they stay in place until the filter changes.
  const readAll = () => {
    keep(...groups.filter(g => g.unread > 0).map(g => g.key));
    inbox.setRead(visibleUnread, true);
  };
  const bulk =
    state === "done"
      ? [
          {
            key: "restore",
            node: (
              <Button variant="outline" disabled={visibleIds.length === 0} onClick={() => inbox.restore(visibleIds)}>
                <RotateCcw className="h-4 w-4" />
                {t("pages.notifications.bulkRestore", { count: visibleIds.length })}
              </Button>
            ),
          },
        ]
      : [
          {
            key: "read",
            node: (
              <Button variant="outline" disabled={visibleUnread.length === 0} onClick={readAll}>
                <CheckCheck className="h-4 w-4" />
                {t("pages.notifications.bulkRead")}
              </Button>
            ),
            menu: (
              <DropdownMenuItem disabled={visibleUnread.length === 0} onSelect={readAll}>
                <CheckCheck className="h-4 w-4" />
                {t("pages.notifications.bulkRead")}
              </DropdownMenuItem>
            ),
          },
          {
            key: "done",
            node: (
              <Button variant="outline" disabled={visibleIds.length === 0} onClick={() => {
                inbox.done(visibleIds);
                setView({ sel: "", open: new Set() });
              }}>
                <Check className="h-4 w-4" />
                {t("pages.notifications.bulkDone", { count: visibleIds.length })}
              </Button>
            ),
          },
        ];

  return (
    <>
      <PageHeader
        sticky
        title={t("pages.notifications.title")}
        description={unreadTotal === 0 ? t("pages.notifications.allRead") : t("pages.notifications.toRead", { count: unreadTotal })}
        actions={reading ? undefined : <Toolbar label={t("pages.notifications.title")} foldBelow="m" groups={[bulk]} />}
      />
      {!reading && (
        <PageToolbar label={t("pages.notifications.filters")}>
          <SegmentedControl
            label={t("pages.notifications.categoriesLabel")}
            value={cat}
            onChange={c => setView({ cat: c, sel: "" })}
            options={NOTIFICATION_CATEGORIES.map(c => ({ value: c, label: `${t(`pages.notifications.categories.${c}`)} ${counts[c]}` }))}
          />
          <SegmentedControl
            label={t("pages.notifications.statesLabel")}
            value={state}
            onChange={s => setView({ state: s, sel: "", open: new Set() })}
            options={INBOX_STATES.map(s => ({
              value: s,
              label: s === "unread" ? `${t("pages.notifications.states.unread")} ${unreadTotal}` : s === "read" ? `${t("pages.notifications.states.read")} ${readTotal}` : t("pages.notifications.states.done"),
            }))}
          />
        </PageToolbar>
      )}
      <div ref={regionRef} className="region">
        <div
          ref={splitRef}
          style={{ "--notifications-preview-w": width === null ? undefined : `${width}px` } as CSSProperties}
          className="@xl:grid @xl:grid-cols-[minmax(0,1fr)_clamp(360px,var(--notifications-preview-w,50cqw),min(60vw,100cqw_-_420px))]"
        >
          <div className={cn("min-w-0 p-3 md:p-4", detail && current && "max-@xl:hidden")}>
            {state === "unread" && (
              <div className="mb-4 grid grid-cols-[minmax(0,1fr)] gap-4 empty:hidden">
                <AlertList />
                <TodoReminders onOpen={() => {}} />
              </div>
            )}
            {inbox.query.isPending ? (
              <div className="grid gap-2">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : inbox.query.error ? (
              <ErrorState message={errorText(inbox.query.error)} onRetry={() => void inbox.query.refetch()} />
            ) : groups.length === 0 ? (
              <EmptyState icon={BellOff} title={t(`pages.notifications.empty.${state}`)} message={t("pages.notifications.emptyMessage")} />
            ) : (
              <section aria-label={t("pages.notifications.list")}>
                <SectionLabel as="h2" className="sr-only">{t("pages.notifications.list")}</SectionLabel>
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                  {groups.map(g => (
                    <GroupRow
                      key={g.key}
                      group={g}
                      state={state}
                      selected={g.key === selected}
                      expanded={open.has(g.key)}
                      onSelect={() => select(g.key, "click")}
                      onToggle={() => toggleOpen(g.key)}
                      onFinish={() => finish(g.key)}
                      onFinishOne={id => (state === "done" ? inbox.restore([id]) : inbox.done([id]))}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>
          <aside
            ref={previewRef}
            id="notifications-preview"
            data-notifications-preview
            data-sticky-pane
            aria-label={t("pages.notifications.preview")}
            className={cn(
              "min-h-0 min-w-0 flex-col @xl:sticky @xl:top-[calc(var(--page-header-h,0px)+var(--page-toolbar-h,0px))] @xl:flex @xl:h-[calc(100dvh-2rem-var(--page-header-h,0px)-var(--page-toolbar-h,0px))] @xl:border-l",
              detail && current ? "flex" : "hidden"
            )}
          >
            <Splitter
              grid={splitRef}
              pane={{ id: "notifications-preview", ref: previewRef }}
              cssVar="--notifications-preview-w"
              bounds={previewBounds}
              onChange={w => previewWidth.set(w)}
              label={t("pages.notifications.resizePreview")}
              className="max-@xl:hidden"
            />
            {current ? (
              <Preview
                group={current}
                state={state}
                position={{ n: at + 1, total: keys.length }}
                onBack={backToList}
                onPrev={at > 0 ? () => select(keys[at - 1]) : undefined}
                onNext={at < keys.length - 1 ? () => select(keys[at + 1]) : undefined}
                onToggleRead={() => toggleRead(current.key)}
                onFinish={() => finish(current.key)}
                onOpenIssue={() => openIssue(current.key)}
                onStart={() => start.mutate({ issueKey: current.issueKey, connectionId: current.connectionId })}
              />
            ) : (
              <EmptyState className="py-16" title={t("pages.notifications.preview")} message={t("pages.notifications.previewEmpty")} />
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

/** "3 comments · 1 status change". */
function summaryText(items: readonly InboxRow[]): string {
  return groupSummary(items)
    .map(s => t(`pages.notifications.summary.${s.category}`, { count: s.count }))
    .join(" · ");
}

/**
 * One issue's notifications: the newest leads (its icon, the issue, what happened in all), a click reads
 * it in the preview; the rest open in place; done takes them all, or one at a time when open.
 */
function GroupRow({
  group: g,
  state,
  selected,
  expanded,
  onSelect,
  onToggle,
  onFinish,
  onFinishOne,
}: {
  group: Group;
  state: InboxState;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onFinish: () => void;
  onFinishOne: (id: number) => void;
}) {
  const style = KIND_STYLE[g.latest.kind] ?? KIND_STYLE.assigned;
  const Icon = style.icon;
  const many = g.items.length > 1;
  const done = state === "done";
  return (
    <li
      data-issue-id={g.key}
      data-selected={selected || undefined}
      {...surface("card", { on: selected })}
      className={cn("grid min-w-0 rounded-lg border bg-card", selected && "border-primary-strong/60 bg-primary-soft/40 ring-1 ring-primary-strong/40")}
    >
      <div className="flex min-w-0 items-center gap-1 pr-1.5">
        <button
          type="button"
          data-row-select
          aria-pressed={selected}
          onClick={onSelect}
          className="flex min-h-target min-w-0 flex-1 items-center gap-3 rounded-lg p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch"
        >
          <span className="relative shrink-0">
            <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", style.tone)} aria-hidden {...surface("picture")}>
              <Icon className="h-4 w-4" />
            </span>
            {g.unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary-strong" {...surface("chip")}>
                <span className="sr-only">{t("pages.notifications.unreadDot")}</span>
              </span>
            )}
          </span>
          <span className="grid min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <ProjectAvatar project={projectOf(g.issueKey)} size="xs" connectionId={g.connectionId} />
              <span className={cn("shrink-0", g.unread > 0 ? "font-semibold" : "font-medium")}>{g.issueKey}</span>
              <span className="truncate text-body-sm">{g.latest.summary ?? "—"}</span>
            </span>
            <span className="mt-0.5 truncate text-caption text-muted-foreground">
              {summaryText(g.items)} · {ago(g.latest.createdAt)}
            </span>
          </span>
        </button>
        {many && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-label={expanded ? t("pages.notifications.collapse", { issueKey: g.issueKey }) : t("pages.notifications.expand", { count: g.items.length, issueKey: g.issueKey })}
            title={expanded ? t("pages.notifications.collapse", { issueKey: g.issueKey }) : t("pages.notifications.expand", { count: g.items.length, issueKey: g.issueKey })}
            onClick={onToggle}
          >
            <ChevronDown className={cn("h-4 w-4", expanded && "rotate-180")} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={done ? t("pages.notifications.restoreGroup", { issueKey: g.issueKey }) : t("pages.notifications.doneGroup", { count: g.items.length, issueKey: g.issueKey })}
          title={done ? t("pages.notifications.restore") : t("pages.notifications.done")}
          onClick={onFinish}
        >
          {done ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" />}
        </Button>
      </div>
      {many && expanded && (
        <ul className="grid grid-cols-[minmax(0,1fr)] border-t py-1 pl-14 pr-1.5">
          {g.items.map(n => (
            <li key={n.id} data-unread={n.readAt === null || undefined} className="flex min-h-target min-w-0 items-center gap-2 coarse:min-h-touch">
              {/* Dot = unread; its slot stays when read, so every row starts at the same edge. */}
              <span className="flex w-1.5 shrink-0 justify-center" aria-hidden>
                {n.readAt === null && <span className="h-1.5 w-1.5 rounded-full bg-primary-strong" {...surface("chip")} />}
              </span>
              <span className={cn("min-w-0 flex-1 truncate text-caption", n.readAt === null ? "font-medium text-foreground" : "text-muted-foreground")}>
                {reason(n.kind, n.detail, n.createdAt)}
                {n.readAt === null && <span className="sr-only">, {t("pages.notifications.unreadDot")}</span>}
              </span>
              {!done && (
                <Button variant="ghost" size="icon-sm" aria-label={t("pages.notifications.doneOne", { issueKey: g.issueKey })} title={t("pages.notifications.done")} onClick={() => onFinishOne(n.id)}>
                  <Check className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The selected group beside the list (or over it on a narrow screen): what happened, the triage actions
 * (read, done → the next one, the issue's page), then the issue itself.
 */
function Preview({
  group: g,
  state,
  position,
  onBack,
  onPrev,
  onNext,
  onToggleRead,
  onFinish,
  onOpenIssue,
  onStart,
}: {
  group: Group;
  state: InboxState;
  position: { n: number; total: number };
  onBack: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onToggleRead: () => void;
  onFinish: () => void;
  onOpenIssue: () => void;
  onStart: () => void;
}) {
  const done = state === "done";
  const canStart = g.items.some(n => KIND_STYLE[n.kind]?.canStart);
  // The issue itself is secondary here: folded until asked for (kept open from one group to the next).
  const [details, setDetails] = useState(false);
  return (
    <>
      {/* Narrower than the split: back to the list, and on to the next one without going back. */}
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2 @xl:hidden" {...surface("ground")}>
        <Button variant="ghost" size="sm" onClick={onBack} title={t("pages.notifications.backHint")}>
          <ChevronLeft className="h-4 w-4" />
          {t("pages.notifications.back")}
        </Button>
        <span className="ml-auto text-caption text-muted-foreground">{t("pages.notifications.position", position)}</span>
        <Button variant="outline" size="icon-sm" aria-label={t("pages.notifications.previous")} title={t("pages.notifications.previous")} disabled={!onPrev} onClick={onPrev}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label={t("pages.notifications.next")} title={t("pages.notifications.next")} disabled={!onNext} onClick={onNext}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid shrink-0 gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-caption text-muted-foreground">{g.issueKey}</p>
          <h2 className="text-body font-semibold [overflow-wrap:anywhere]">{g.latest.summary ?? g.issueKey}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {done ? (
            <Button size="sm" onClick={onFinish}>
              <RotateCcw className="h-4 w-4" />
              {t("pages.notifications.restore")}
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={onFinish} title={`${t("pages.notifications.done")} (e)`}>
                <Check className="h-4 w-4" />
                {t("pages.notifications.done")}
              </Button>
              <Button variant="outline" size="sm" onClick={onToggleRead} title={g.unread > 0 ? t("pages.notifications.markRead") : `${t("pages.notifications.markUnread")} (u)`}>
                {g.unread > 0 ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
                {g.unread > 0 ? t("pages.notifications.markRead") : t("pages.notifications.markUnread")}
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={onOpenIssue}>
            <ArrowUpRight className="h-4 w-4" />
            {t("pages.notifications.openIssue")}
          </Button>
          {canStart && !done && (
            <Button variant="ghost" size="icon-sm" aria-label={t("settings.notifications.startTimer", { issueKey: g.issueKey })} title={t("settings.notifications.startTimerShort")} onClick={onStart}>
              <Play className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-col @xl:flex-1 @xl:overflow-y-auto" data-scroll-key={`notification-${g.key}`}>
        <section aria-label={t("pages.notifications.happened")} className="grid gap-1 border-b px-4 py-3">
          <SectionLabel as="h3" className="px-0">{t("pages.notifications.happened")}</SectionLabel>
          <NotificationEvents items={g.items} issueKey={g.issueKey} connectionId={g.connectionId} />
          <KeysHint />
        </section>
        <section aria-label={t("pages.notifications.details")} className="min-w-0">
          <button
            type="button"
            aria-expanded={details}
            aria-controls={`notification-details-${g.key}`}
            onClick={() => setDetails(v => !v)}
            className="flex min-h-target w-full items-center gap-2 border-b px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring coarse:min-h-touch"
          >
            <SectionLabel as="h3" className="flex-1 px-0">{t("pages.notifications.details")}</SectionLabel>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground", details && "rotate-180")} aria-hidden />
          </button>
          {details && (
        <div id={`notification-details-${g.key}`} className="min-h-0">
          <IssueBody
            variant="pane"
            issueKey={g.issueKey}
            connectionId={g.connectionId}
            maxSize="m"
            scrollKeyPrefix="notification-issue"
            // Key and title are above (one datum, one place): the issue's status and actions only.
            header={({ issue, data, act, connectionId, onLogTime }) =>
              issue ? (
                <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <StatusBadge status={issue.status} category={issue.category} />
                  </div>
                  <IssueActions issue={issue} data={data} connectionId={connectionId} act={act} onLogTime={onLogTime} compact />
                </div>
              ) : null
            }
          />
        </div>
          )}
        </section>
      </div>
    </>
  );
}

/** The page's keys, as key caps on one line (they wrap between pairs, never inside one). */
function KeysHint() {
  const pairs: [string[], string][] = [
    [["j", "k"], t("pages.notifications.keys.move")],
    [["e"], t("pages.notifications.keys.done")],
    [["u"], t("pages.notifications.keys.unread")],
    [[t("ui.keys.enter")], t("pages.notifications.keys.open")],
    [[t("pages.notifications.keys.esc")], t("pages.notifications.keys.back")],
  ];
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground coarse:hidden max-@xl:hidden">
      {pairs.map(([keys, label]) => (
        <span key={label} className="inline-flex items-center gap-1 whitespace-nowrap">
          {keys.map(k => <Kbd key={k}>{k}</Kbd>)}
          {label}
        </span>
      ))}
    </p>
  );
}
