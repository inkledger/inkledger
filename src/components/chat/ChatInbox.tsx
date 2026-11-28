import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { NavigationType, useLocation, useNavigate, useNavigationType } from "react-router";
import { BellOff, MessageCircle, Pin, Search } from "lucide-react";
import { CHAT_FILTERS, CHAT_SEARCH_MIN, type ChatFilter, type ChatThreadView } from "@contracts/chat";
import { PageToolbar } from "@/components/app/PageToolbar";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Splitter } from "@/components/app/Splitter";
import { EmptyState, ErrorState } from "@/components/app/States";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Chip } from "@/components/app/Chip";
import { SectionLabel } from "@/components/app/PageHeader";
import { surface } from "@/components/app/surface";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useListKeyboard } from "@/hooks/useListKeyboard";
import { useUrlFields } from "@/hooks/useUrlState";
import { trpc } from "@/lib/trpc";
import { errorText } from "@/lib/errorText";
import { issuePath } from "@/lib/issues";
import { relativeTime } from "@/lib/initials";
import { formatWidth, parseWidth, splitBounds } from "@/lib/layout/split";
import { regionSize } from "@/lib/layout/regions";
import { projectOf } from "@/lib/projectColors";
import { deviceSetting } from "@/lib/storage";
import { createStore } from "@/lib/store";
import { flag, int, oneOf, text, type Fields } from "@/lib/urlCodecs";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { AvatarStack } from "./People";
import { nameIn, namesList } from "./chatText";
import { ChatThread } from "./ChatThread";

type View = { filter: ChatFilter; q: string; thread: number; msg: number; detail: boolean };

/** What the Chat tab keeps in the URL: Back from an issue finds the filter, the search and the chat as they were. */
const FIELDS: Fields<View> = {
  filter: { key: "chats", fallback: "all", codec: oneOf(CHAT_FILTERS) },
  q: { key: "cq", fallback: "", codec: text },
  thread: { key: "thread", fallback: 0, codec: int },
  msg: { key: "msg", fallback: 0, codec: int },
  detail: { key: "cdetail", fallback: false, codec: flag },
};

const previewWidth = deviceSetting("ikl-chat-preview-width", parseWidth, formatWidth);
const previewBounds = (container: number) => splitBounds({ container, viewport: window.innerWidth, paneMin: 380, mainMin: 320, viewportShare: 0.7 });
/** The chat the detail showed when its Back was pressed: the list selects it again. */
const selectAfterBack = createStore<number | null>(null);

/**
 * The Chat tab of Notifications: the reader's chats (pinned first, then the latest), filtered
 * and searched, and the one picked beside the list from a wide region, over it when narrower
 * (Back returns). j/k move, Enter opens the issue, Esc goes back.
 */
export function ChatInbox() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [view, setView] = useUrlFields(FIELDS);
  const self = useAuth().user?.id ?? null;
  const [typed, setTyped] = useState(view.q);
  useEffect(() => {
    const timer = setTimeout(() => typed !== view.q && setView({ q: typed }), 250);
    return () => clearTimeout(timer);
  }, [typed, view.q, setView]);
  const threads = trpc.chat.threads.useQuery({ filter: view.filter, q: view.q || undefined }, { placeholderData: (prev) => prev, refetchInterval: 60_000 });
  const found = trpc.chat.search.useQuery({ q: view.q }, { enabled: view.q.trim().length >= CHAT_SEARCH_MIN });
  const unread = trpc.chat.unreadCount.useQuery(undefined, { refetchInterval: 60_000 });
  const list = threads.data?.threads ?? [];
  const keys = list.map((th) => String(th.id));
  const selected = view.thread && (list.some((th) => th.id === view.thread) || view.detail) ? view.thread : null;

  const regionRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const width = previewWidth.use();
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(regionSize(el.clientWidth, parseFloat(getComputedStyle(document.documentElement).fontSize)) === "xl"));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const select = (id: number | null, how: "click" | "keys" = "keys") => {
    if (id === null) setView({ thread: 0, msg: 0 });
    else if (how === "click" && !wide) setView({ thread: id, msg: 0, detail: true }, { push: true });
    else setView({ thread: id, msg: 0 });
  };
  const backToList = () => {
    if (location.key === "default" || navigationType !== NavigationType.Push) {
      setView({ detail: false });
      return;
    }
    selectAfterBack.set(selected);
    void navigate(-1);
  };
  useEffect(() => {
    const id = selectAfterBack.get();
    if (id === null || view.detail) return;
    selectAfterBack.set(null);
    if (id !== view.thread) setView({ thread: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per history entry: the one Back landed on
  }, [location.key]);

  const byId = (id: string) => list.find((th) => String(th.id) === id) ?? null;
  const openIssue = (id: string) => {
    const th = byId(id);
    if (th?.issue.connectionId) void navigate(issuePath({ key: th.issue.key, connectionId: th.issue.connectionId, remoteId: th.issue.remoteId }));
  };
  useListKeyboard(
    keys,
    {
      open: openIssue,
      escape: () => (view.detail && !wide ? backToList() : select(null)),
    },
    { selected: selected === null ? null : String(selected), onSelect: (key) => select(key === null ? null : Number(key)) },
  );

  const reading = view.detail && !wide && selected !== null;
  // Over the list (narrow), the chat fills what is left of the screen above the tab bar, measured where it
  // starts (the phone's own bar, the header): the composer always in reach, with the keyboard up too.
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el || !reading) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top;
      const height = window.visualViewport?.height ?? window.innerHeight;
      // It ends where the first of these does: the window, the page's panel (a desktop's margin), the phone's
      // tab bar (and the timer button standing on it), with a little room.
      const main = document.getElementById("main")?.getBoundingClientRect();
      const bar = document.querySelector<HTMLElement>("[data-tab-bar]");
      // (fixed: no offsetParent to tell it is shown; a drawn bar has a height)
      const barBox = bar?.getBoundingClientRect();
      const barTop = barBox && barBox.height > 0 ? barBox.top - 12 : Infinity;
      const bottom = Math.min(height, main ? main.bottom - 1 : Infinity, barTop);
      el.style.height = `${Math.max(0, bottom - top - 8)}px`;
    };
    fit();
    // What sits above it changes height (the header's "n unread" line comes and goes): measured again.
    // Its ancestors up to the panel change size whenever something above it does.
    const ro = new ResizeObserver(fit);
    for (let n = el.parentElement; n; n = n.parentElement) {
      ro.observe(n);
      if (n.id === "main") break;
    }
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      el.style.height = "";
    };
  }, [reading]);
  const unreadThreads = unread.data?.threads ?? 0;
  return (
    <>
      {!reading && (
        <PageToolbar label={t("pages.chat.filtersLabel")}>
          <SegmentedControl
            label={t("pages.chat.filtersLabel")}
            value={view.filter}
            onChange={(f) => setView({ filter: f, thread: 0, msg: 0 })}
            options={CHAT_FILTERS.map((f) => ({ value: f, label: f === "unread" ? `${t("pages.chat.filters.unread")} ${unreadThreads}` : t(`pages.chat.filters.${f}`) }))}
          />
          <label className="relative min-w-0 flex-1 basis-56">
            <span className="sr-only">{t("pages.chat.search")}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t("pages.chat.searchPlaceholder")} className="pl-8" />
          </label>
        </PageToolbar>
      )}
      <div ref={regionRef} className="region">
        <div
          ref={splitRef}
          style={{ "--chat-preview-w": width === null ? undefined : `${width}px` } as CSSProperties}
          className="@xl:grid @xl:grid-cols-[minmax(0,1fr)_clamp(380px,var(--chat-preview-w,60cqw),min(70vw,100cqw_-_320px))]"
        >
          <div className={cn("min-w-0 p-3 md:p-4", reading && "@max-xl:hidden")}>
            {threads.isPending ? (
              <div className="grid gap-2" role="status" aria-label={t("pages.chat.messages.loading")}>
                <Skeleton className="h-16" aria-hidden />
                <Skeleton className="h-16" aria-hidden />
                <Skeleton className="h-16" aria-hidden />
              </div>
            ) : threads.error ? (
              <ErrorState message={errorText(threads.error)} onRetry={() => void threads.refetch()} />
            ) : (
              <>
                {list.length === 0 ? (
                  <EmptyState icon={MessageCircle} title={t(`pages.chat.empty.${view.filter}`)} message={t("pages.chat.emptyMessage")} />
                ) : (
                  <section aria-label={t("pages.chat.list")}>
                    <SectionLabel as="h2" className="sr-only">
                      {t("pages.chat.list")}
                    </SectionLabel>
                    <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5" data-chat-list>
                      {list.map((th) => (
                        <ThreadRow key={th.id} th={th} self={self} selected={th.id === selected} onSelect={() => select(th.id, "click")} />
                      ))}
                    </ul>
                  </section>
                )}
                {view.q.trim().length >= CHAT_SEARCH_MIN && (found.data ?? []).length > 0 && (
                  <section aria-label={t("pages.chat.searchMessages", { q: view.q })} className="mt-4">
                    <SectionLabel as="h2">{t("pages.chat.searchMessages", { q: view.q })}</SectionLabel>
                    <ul className="mt-1 grid grid-cols-[minmax(0,1fr)] gap-1">
                      {(found.data ?? []).map((r) => (
                        <li key={r.message.id}>
                          <button
                            type="button"
                            onClick={() => setView({ thread: r.threadId, msg: r.message.id, detail: !wide }, { push: !wide })}
                            className="grid min-h-target w-full gap-0.5 rounded-md px-2 py-1.5 text-left outline-clear hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch"
                          >
                            <span className="text-caption text-muted-foreground">{r.issueKey}</span>
                            <span className="line-clamp-2 text-body-sm [overflow-wrap:anywhere]">{r.message.body}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {threads.data?.more && <p className="mt-2 text-center text-caption text-muted-foreground">…</p>}
              </>
            )}
          </div>
          <aside
            ref={previewRef}
            id="chat-preview"
            data-sticky-pane
            aria-label={t("pages.chat.preview")}
            className={cn(
              "min-h-0 min-w-0 flex-col @xl:sticky @xl:top-[calc(var(--page-header-h,0px)+var(--page-toolbar-h,0px))] @xl:flex @xl:h-[calc(100dvh-2rem-var(--page-header-h,0px)-var(--page-toolbar-h,0px))] @xl:border-l",
              reading ? "flex min-h-80" : "hidden",
            )}
          >
            <Splitter grid={splitRef} pane={{ id: "chat-preview", ref: previewRef }} cssVar="--chat-preview-w" bounds={previewBounds} onChange={(w) => previewWidth.set(w)} label={t("pages.chat.resizePreview")} className="@max-xl:hidden" />
            {selected !== null ? (
              <ChatThread
                key={selected}
                threadId={selected}
                onBack={reading ? backToList : undefined}
                focusId={view.msg || null}
                onGone={() => {
                  setView({ thread: 0, msg: 0, detail: false });
                }}
              />
            ) : (
              <EmptyState className="py-16" icon={MessageCircle} title={t("pages.chat.preview")} message={t("pages.chat.previewEmpty")} />
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

/** One chat in the list: its people, its issue, the latest line, how much is unread. */
function ThreadRow({ th, self, selected, onSelect }: { th: ChatThreadView; self: number | null; selected: boolean; onSelect: () => void }) {
  const others = th.members.filter((m) => m.userId !== self && !m.left);
  const [now] = useState(() => Date.now());
  const last = th.last;
  const preview = !last
    ? ""
    : last.kind === "system"
      ? ""
      : // Who wrote it, unless it can only be the one person shown already (a 1:1).
        `${last.authorId === self ? `${t("pages.chat.you")}: ` : others.length > 1 ? `${nameIn(th.members, last.authorId, self)}: ` : ""}${last.preview || (last.files > 0 ? t("pages.chat.filesOnly", { count: last.files }) : "")}`;
  return (
    <li
      data-thread-id={th.id}
      data-selected={selected || undefined}
      {...surface("card", { on: selected })}
      className={cn("grid min-w-0 rounded-lg border bg-card", selected && "border-primary-strong/60 bg-primary-soft/40 ring-1 ring-primary-strong/40")}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="grid min-h-target min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg p-2.5 text-left outline-clear focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch"
      >
        <span className="relative">
          <AvatarStack names={others.map((m) => m.name)} max={2} size="sm" />
          {th.unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary-strong" {...surface("chip")}>
              <span className="sr-only">{t("pages.chat.unread", { count: th.unread })}</span>
            </span>
          )}
        </span>
        <span className="grid min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <ProjectAvatar project={projectOf(th.issue.key)} size="xs" connectionId={th.issue.connectionId} />
            <span className={cn("shrink-0", th.unread > 0 ? "font-semibold" : "font-medium")}>{th.issue.key}</span>
            <span className="truncate text-body-sm">{th.issue.title}</span>
          </span>
          <span className={cn("mt-0.5 truncate text-caption", th.unread > 0 ? "text-foreground" : "text-muted-foreground")}>
            {namesList(others.map((m) => m.name), 2)}
            {preview && ` · ${preview}`}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-caption text-muted-foreground tabular-nums">{relativeTime(new Date(th.lastMessageAt), now)}</span>
          <span className="flex items-center gap-1">
            {th.state === "resolved" && (
              <Chip tone="success" variant="dot">
                {t("pages.chat.header.resolved")}
              </Chip>
            )}
            {th.pinned && <Pin className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("pages.chat.header.pin")} />}
            {th.muted && <BellOff className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("pages.chat.header.muted")} />}
            {th.unread > 0 && (
              <span className="rounded-full bg-primary-soft px-1.5 text-2xs font-semibold text-primary-strong tabular-nums" {...surface("chip")} aria-hidden>
                {th.unread}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

