import { DESK_MAX_PANES } from "@contracts/desk";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  BarChart3,
  CalendarDays,
  Keyboard,
  KanbanSquare,
  LayoutPanelLeft,
  Settings as SettingsIcon,
  LayoutDashboard,
  ListTodo,
  Moon,
  NotebookPen,
  Lightbulb,
  Play,
  Sunset,
  Maximize2,
  RefreshCw,
  Sun,
  Plus,
  Pin,
  Info as InfoIcon,
  ExternalLink,
  Layers,
  Search,
  ListChecks,
  MoveRight,
  Pause,
  Square,
  Sparkles,
  MailPlus,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { useSync } from "@/hooks/useSync";
import { visibleIssues, issuePath, issueId, parseIssuePath } from "@/lib/issues";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { VirtualCommand } from "@/components/app/VirtualCommand";
import type { CommandOption, CommandSection } from "@/lib/commandRows";
import { commandPalette } from "@/lib/commandPalette";
import { shortcutsHelp } from "@/lib/shortcuts";
import { quickStart } from "@/lib/quickStart";
import { useTimers } from "@/hooks/useTimers";
import { useTimerActions } from "@/hooks/useTimerActions";
import { createIssueDialog, dayReview, focusMode, ideaCapture, screensaver } from "@/lib/flag";
import { openPinMail } from "@/components/mail/pinMail";
import { togglePinboard, usePinboardTarget } from "@/hooks/usePinboardPanel";
import { toggleTodos, useTodoTarget } from "@/hooks/useTodoPanel";
import { Kbd } from "@/components/app/Kbd";
import { useProviderName } from "@/hooks/useConnections";
import { t, useLocale } from "@/i18n";
import { BUCKET_SCOPE, useBuckets } from "@/hooks/useBuckets";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatQuery, parseQuery } from "@contracts/query";
import { newDraftId } from "@/components/notes/drafts";
import { emitWorkspaceSearch } from "@/lib/workspace/searchEvents";
import { focusTimer } from "@/lib/timerFocus";

/**
 * Global ⌘K palette: jump to any issue, navigate, sync, toggle theme.
 * The fastest way to operate the app without touching the mouse.
 * Its shortcut lives in the first load (useCommandPaletteShortcut); this body follows.
 */
export function CommandPalette() {
  const open = commandPalette.useValue();
  const searchSelected = useRef(false);
  const searchWasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      if (!searchWasOpen.current) {
        searchSelected.current = false;
        searchWasOpen.current = true;
        emitWorkspaceSearch("search.opened");
      }
      return;
    }
    if (searchWasOpen.current && !searchSelected.current) emitWorkspaceSearch("search.abandoned");
    searchWasOpen.current = false;
  }, [open]);
  // Kept while closed: reopened, the palette shows what was typed.
  const [typed, setTyped] = useState("");
  const query = useDebouncedValue(typed.trim(), 300);

  return (
    <Dialog open={open} onOpenChange={commandPalette.set}>
      <DialogContent className="overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("ui.palette.title")}</DialogTitle>
          <DialogDescription>{t("ui.palette.description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while the dialog shows: closed, the palette follows no timers, sync or buckets. */}
        <PaletteBody open={open} typed={typed} setTyped={setTyped} query={query} onSelected={() => {
          searchSelected.current = true;
        }} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One choice of the palette: what a search matches (`search`, and `keywords` such as the
 * shortcut shown beside it), how it is drawn and what it does.
 */
type Entry = CommandOption & { view: ReactNode; run: () => void };

const entry = (id: string, search: string, view: ReactNode, run: () => void, extra: { keywords?: string[]; forceShow?: boolean } = {}): Entry => ({
  id,
  search,
  view,
  run,
  ...extra,
});

function PaletteBody({ open, typed, setTyped, query, onSelected }: {
  open: boolean;
  typed: string;
  setTyped: (value: string) => void;
  query: string;
  onSelected: () => void;
}) {
  const setOpen = commandPalette.set;
  const navigate = useNavigate();
  const { setTheme, resolvedTheme } = useTheme();
  const { pathname } = useLocation();
  const pinTarget = usePinboardTarget(pathname);
  const todoTarget = useTodoTarget(pathname);

  // Local issues for instant jump-to-issue (cached, no extra load)
  const issues = trpc.issues.all.useQuery(BUCKET_SCOPE, {
    enabled: open,
    staleTime: 60_000,
  });
  // Past what the list holds (a big catalogue): the server searches the rest.
  const size = trpc.issues.allSize.useQuery(BUCKET_SCOPE, { enabled: open, staleTime: 60_000 });
  const beyond = !!size.data && size.data.total > size.data.limit;
  const more = trpc.issues.list.useQuery(
    { search: query, includeDone: true, includeUnassigned: true, pageSize: 20 },
    { enabled: open && beyond && query.length >= 2, staleTime: 30_000 }
  );
  // A key or link pasted: the issue it names, from the catalogue or its tracker.
  const pasted = query.length >= 2 && parseQuery(query).expr?.kind === "ref";
  const opened = trpc.issues.open.useQuery({ text: query }, { enabled: open && pasted, staleTime: 30_000 });
  const kept = trpc.queries.list.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const noteResults = trpc.notes.search.useQuery({ query, filter: "all", limit: 8 }, { enabled: open && query.length >= 2, staleTime: 15_000 });
  const lang = useLocale() === "it" ? "it" : "en";
  const buckets = useBuckets();
  const listed = new Set((issues.data ?? []).map(i => issueId(i)));
  const extra = (more.data?.issues ?? []).filter(i => !listed.has(issueId(i)));

  const sync = useSync();
  const provider = useProviderName();

  const go = (path: string) => {
    onSelected();
    emitWorkspaceSearch("search.selected", path);
    setOpen(false);
    void navigate(path);
  };

  const close = () => setOpen(false);
  // A shortcut beside a label is searched too (cmdk matched the item's whole text).
  const nav = (id: string, path: string, icon: ReactNode, label: string, kbd?: string) =>
    entry(id, label, <>{icon} {label}{kbd && <Kbd className="ml-auto text-muted-foreground">{kbd}</Kbd>}</>, () => go(path), kbd ? { keywords: [kbd] } : {});
  const action = (id: string, icon: ReactNode, label: string, run: () => void, kbd?: string) =>
    entry(id, label, <>{icon} {label}{kbd && <Kbd className="ml-auto text-muted-foreground">{kbd}</Kbd>}</>, () => {
      close();
      run();
    }, kbd ? { keywords: [kbd] } : {});
  const deskEntry = useAddToDeskEntry(pathname, close);
  const timerEntries = useTimerEntries(close);
  const issueView = (i: { key: string; summary: string; favorite?: number }) => (
    <>
      <span className="mr-2 text-caption text-muted-foreground">{i.key}</span>
      <span className="truncate">{i.summary}</span>
      {i.favorite === 1 && (
        <span className="ml-2 text-warning" aria-label={t("ui.palette.favorite")}>
          ★
        </span>
      )}
    </>
  );

  const groups: { id: string; heading: string; entries: Entry[] }[] = [
    {
      id: "pasted",
      heading: t("ui.palette.openPasted"),
      entries: pasted
        ? (opened.data ?? []).map(i =>
            entry(
              `open:${i.connectionId}:${i.remoteId}`,
              `open ${query} ${i.key}`,
              <>
                <ExternalLink className="mr-2 h-4 w-4" />
                <span className="truncate">{t("ui.palette.openKey", { key: i.key })}</span>
              </>,
              () => go(issuePath({ key: i.key, connectionId: i.connectionId, remoteId: i.remoteId })),
              { forceShow: true }
            )
          )
        : [],
    },
    {
      id: "saved",
      heading: t("ui.palette.savedSearches"),
      entries: (kept.data?.saved ?? []).map(sv => {
        const shown = formatQuery(parseQuery(sv.query).expr, lang) || sv.query;
        return entry(
          `saved:${sv.id}`,
          `saved ${sv.name} ${sv.query}`,
          <>
            <Search className="mr-2 h-4 w-4" />
            <span className="mr-2">{sv.name}</span>
            <span className="truncate text-caption text-muted-foreground">{shown}</span>
          </>,
          () => go(`/issues?q=${encodeURIComponent(shown)}`)
        );
      }),
    },
    {
      id: "notes",
      heading: t("ui.palette.noteResults"),
      entries: (noteResults.data?.results ?? []).map(note =>
        entry(
          `note:${note.id}`,
          `note ${note.title} ${note.snippet} ${note.id}`,
          <>
            <NotebookPen className="mr-2 h-4 w-4" />
            <span className="min-w-0">
              <span className="block truncate">{note.title || t("pages.notes.untitled")}</span>
              {note.snippet && <span className="block truncate text-caption text-muted-foreground">{note.snippet}</span>}
            </span>
          </>,
          () => go(`/notes/${note.id}`),
          { forceShow: true }
        )
      ),
    },
    {
      id: "issues",
      heading: t("ui.palette.issues"),
      // Its connection too: one key and title on two trackers are two options, never one.
      entries: visibleIssues(issues.data ?? []).map(i => entry(`issue:${issueId(i)}`, `${i.key} ${i.summary} ${issueId(i)}`, issueView(i), () => go(issuePath(i)))),
    },
    {
      id: "more",
      heading: t("ui.palette.moreIssues"),
      entries: extra.map(i => entry(`more:${issueId(i)}`, `${i.key} ${i.summary} ${issueId(i)}`, issueView({ key: i.key, summary: i.summary }), () => go(issuePath(i)))),
    },
    {
      id: "buckets",
      heading: t("ui.palette.buckets"),
      entries:
        buckets.buckets.length === 0
          ? []
          : [
              { id: "bucket:all", name: t("ui.buckets.everything"), active: buckets.active === null, choose: null },
              ...buckets.buckets.map(b => ({ id: `bucket:${b.id}`, name: b.name, active: buckets.active?.id === b.id, choose: b.id })),
            ].map(b =>
              entry(
                b.id,
                `bucket ${b.name}`,
                <>
                  <Layers className="mr-2 h-4 w-4" />
                  {t("ui.palette.showBucket", { name: b.name })}
                  {b.active && <span className="ml-auto text-caption text-muted-foreground">✓</span>}
                </>,
                () => {
                  buckets.choose(b.choose);
                  close();
                }
              )
            ),
    },
    {
      id: "navigation",
      heading: t("ui.palette.navigation"),
      entries: [
        nav("nav:dashboard", "/", <LayoutDashboard className="mr-2 h-4 w-4" />, t("ui.nav.dashboard")),
        nav("nav:issues", "/issues", <ListTodo className="mr-2 h-4 w-4" />, t("ui.nav.issues")),
        {
          ...nav("nav:desk", "/issues/desk", <LayoutPanelLeft className="mr-2 h-4 w-4" />, t("ui.palette.openDesk"), "G E"),
          search: `${t("ui.palette.openDesk")} ${t("ui.nav.desk")}`,
        },
        nav("nav:notes", "/notes", <NotebookPen className="mr-2 h-4 w-4" />, t("ui.nav.notes"), "G N"),
        nav("nav:timesheet", "/timesheet", <CalendarDays className="mr-2 h-4 w-4" />, t("ui.nav.timesheet")),
        nav("nav:ideas", "/ideas", <Lightbulb className="mr-2 h-4 w-4" />, t("ui.nav.ideas")),
        nav("nav:board", "/board", <KanbanSquare className="mr-2 h-4 w-4" />, t("ui.nav.board")),
        nav("nav:reports", "/reports", <BarChart3 className="mr-2 h-4 w-4" />, t("ui.nav.reports")),
        nav("nav:settings", "/settings", <SettingsIcon className="mr-2 h-4 w-4" />, t("ui.nav.settings")),
        nav("nav:info", "/info", <InfoIcon className="mr-2 h-4 w-4" />, t("ui.nav.info")),
      ],
    },
    {
      id: "actions",
      heading: t("ui.palette.actions"),
      entries: [
        ...(deskEntry ? [deskEntry] : []),
        action("act:closeDay", <Sunset className="mr-2 h-4 w-4" />, t("ui.palette.closeDay"), () => dayReview.set(true)),
        action("act:focus", <Maximize2 className="mr-2 h-4 w-4" />, t("ui.palette.focusMode"), () => focusMode.set(true), "F"),
        action("act:screensaver", <Sparkles className="mr-2 h-4 w-4" />, t("ui.palette.screensaver"), () => screensaver.set(true), "Z"),
        entry("act:newNote", t("ui.palette.newNote"), <><NotebookPen className="mr-2 h-4 w-4" /> {t("ui.palette.newNote")}</>, () => go(`/notes/new?draft=${newDraftId()}`)),
        action("act:newIdea", <Lightbulb className="mr-2 h-4 w-4" />, t("ui.palette.newIdea"), () => ideaCapture.set(true)),
        action("act:pinMail", <MailPlus className="mr-2 h-4 w-4" />, t("ui.palette.pinMail"), () => openPinMail()),
        action("act:newIssue", <Plus className="mr-2 h-4 w-4" />, t("ui.palette.newIssue"), () => createIssueDialog.set(true), "I"),
        ...(pinTarget !== null
          ? [action("act:pinboard", <Pin className="mr-2 h-4 w-4 -rotate-12" />, t("ui.palette.pinboard"), () => requestAnimationFrame(() => togglePinboard()), "P")]
          : []),
        ...(todoTarget !== null
          ? [action("act:todos", <ListChecks className="mr-2 h-4 w-4" />, t("ui.palette.todos"), () => requestAnimationFrame(() => toggleTodos()), "D")]
          : []),
        ...timerEntries,
        action("act:startTimer", <Play className="mr-2 h-4 w-4" />, t("ui.palette.startTimer"), () => quickStart.set(true), "T"),
        action("act:sync", <RefreshCw className="mr-2 h-4 w-4" />, t("ui.palette.syncJira", { provider }), () => sync.mutate()),
        action("act:shortcuts", <Keyboard className="mr-2 h-4 w-4" />, t("ui.palette.shortcuts"), () => shortcutsHelp.set(true)),
        entry(
          "act:theme",
          t("ui.palette.toggleTheme"),
          <>
            {resolvedTheme === "dark" ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
            {t("ui.palette.toggleTheme")}
          </>,
          () => {
            setTheme(resolvedTheme === "dark" ? "light" : "dark");
            close();
          }
        ),
      ],
    },
  ];
  const byId = new Map(groups.flatMap(g => g.entries.map(e => [e.id, e] as const)));
  const sections: CommandSection[] = groups.map(g => ({ id: g.id, heading: g.heading, options: g.entries }));

  return (
    <VirtualCommand
      size="dialog"
      sections={sections}
      query={typed}
      onQueryChange={setTyped}
      onSelect={id => {
        if (id) byId.get(id)?.run();
      }}
      renderOption={o => byId.get(o.id)?.view ?? null}
      placeholder={t("ui.palette.placeholder")}
      label={t("ui.palette.title")}
      empty={t("ui.palette.empty")}
      footer={
        <div className="flex items-center gap-4 border-t px-3 py-2 text-caption text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd className="px-1">↑</Kbd>
            <Kbd className="px-1">↓</Kbd> {t("ui.palette.navigate")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>{t("ui.keys.enter")}</Kbd> {t("ui.palette.open")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd> {t("ui.palette.close")}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>?</Kbd> {t("ui.palette.shortcutsHint")}
          </span>
        </div>
      }
    />
  );
}

/**
 * On an issue's page: "Add KEY to desk". The server puts it there (a full desk parks
 * its last pane); a toast says what happened and goes to the desk.
 */
function useAddToDeskEntry(pathname: string, onDone: () => void): Entry | null {
  const { search } = useLocation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const shown = parseIssuePath(pathname + search);
  // The issue page asked the same (cached): its key today.
  const located = trpc.issues.locate.useQuery(shown && "remoteId" in shown ? shown : { key: "-" }, { enabled: !!shown && "remoteId" in shown, staleTime: 60_000 });
  const add = trpc.desks.add.useMutation({
    onSuccess: r => {
      utils.desks.current.setData(undefined, r.layout);
      const message = r.already
        ? t("pages.desk.already", { key: r.key })
        : r.parked
          ? t("pages.desk.addedParked", { key: r.key, parked: r.parked })
          : t("pages.desk.added", { key: r.key, count: r.count, max: DESK_MAX_PANES });
      toast(message, { action: { label: t("ui.palette.openDesk"), onClick: () => void navigate("/issues/desk") } });
    },
    onError: error => toastError(error),
  });
  const target = !shown ? null : "key" in shown ? shown : located.data && !("ambiguous" in located.data) ? { key: located.data.key, connectionId: located.data.connectionId } : null;
  if (!target) return null;
  const label = t("ui.palette.addToDesk", { key: target.key });
  return entry("act:addToDesk", label, <><LayoutPanelLeft className="mr-2 h-4 w-4" /> {label}</>, () => {
    onDone();
    add.mutate(target);
  });
}

/**
 * The timer at hand (running, else the last paused): its own commands, as its buttons have them:
 * pause or resume, stop and log (the usual log dialog, with its issue and time), move to another
 * issue. Keyboard first, from any page. None while another device holds it.
 */
function useTimerEntries(onDone: () => void): Entry[] {
  const { timers } = useTimers();
  const current = focusTimer(timers);
  const issueKey = current?.issueKey ?? "";
  const { move, pause, start, stop, running, paused, heldElsewhere } = useTimerActions(issueKey, current?.connectionId);
  if (!current || heldElsewhere) return [];
  const item = (id: string, label: string, icon: ReactNode, act: () => void) =>
    entry(`timer:${id}`, label, <>{icon} {label}</>, () => {
      onDone();
      act();
    });
  return [
    ...(running ? [item("pause", t("ui.timer.pauseFor", { key: issueKey }), <Pause className="mr-2 h-4 w-4" />, pause)] : []),
    ...(paused ? [item("resume", t("ui.timer.resumeFor", { key: issueKey }), <Play className="mr-2 h-4 w-4" />, start)] : []),
    ...(running || paused ? [item("stop", t("ui.timer.stopAndLogFor", { key: issueKey }), <Square className="mr-2 h-4 w-4" />, stop)] : []),
    item("move", t("ui.timer.moveToFor", { key: issueKey }), <MoveRight className="mr-2 h-4 w-4" />, move),
  ];
}
