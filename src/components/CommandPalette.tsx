import { DESK_MAX_PANES } from "@contracts/desk";
import { useEffect, useRef, useState } from "react";
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
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
    <CommandDialog
      open={open}
      onOpenChange={commandPalette.set}
      title={t("ui.palette.title")}
      description={t("ui.palette.description")}
    >
      {/* Mounted only while the dialog shows: closed, the palette follows no timers, sync or buckets. */}
      <PaletteBody open={open} typed={typed} setTyped={setTyped} query={query} onSelected={() => {
        searchSelected.current = true;
      }} />
    </CommandDialog>
  );
}

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

  return (
    <>
      <CommandInput placeholder={t("ui.palette.placeholder")} value={typed} onValueChange={setTyped} />
      <CommandList>
        <CommandEmpty>{t("ui.palette.empty")}</CommandEmpty>
        {pasted && (opened.data ?? []).length > 0 && (
          <CommandGroup heading={t("ui.palette.openPasted")} forceMount>
            {(opened.data ?? []).map(i => (
              <CommandItem key={`${i.connectionId}:${i.remoteId}`} value={`open ${query} ${i.key}`} forceMount onSelect={() => go(issuePath({ key: i.key, connectionId: i.connectionId, remoteId: i.remoteId }))}>
                <ExternalLink className="mr-2 h-4 w-4" />
                <span className="truncate">{t("ui.palette.openKey", { key: i.key })}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(kept.data?.saved ?? []).length > 0 && (
          <CommandGroup heading={t("ui.palette.savedSearches")}>
            {(kept.data?.saved ?? []).map(s => (
              <CommandItem key={s.id} value={`saved ${s.name} ${s.query}`} onSelect={() => go(`/issues?q=${encodeURIComponent(formatQuery(parseQuery(s.query).expr, lang) || s.query)}`)}>
                <Search className="mr-2 h-4 w-4" />
                <span className="mr-2">{s.name}</span>
                <span className="truncate text-caption text-muted-foreground">{formatQuery(parseQuery(s.query).expr, lang) || s.query}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(noteResults.data?.results ?? []).length > 0 && (
          <CommandGroup heading={t("ui.palette.noteResults")} forceMount>
            {(noteResults.data?.results ?? []).map(note => (
              <CommandItem key={note.id} value={`note ${note.title} ${note.snippet} ${note.id}`} forceMount onSelect={() => go(`/notes/${note.id}`)}>
                <NotebookPen className="mr-2 h-4 w-4" />
                <span className="min-w-0"><span className="block truncate">{note.title || t("pages.notes.untitled")}</span>{note.snippet && <span className="block truncate text-caption text-muted-foreground">{note.snippet}</span>}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading={t("ui.palette.issues")}>
          {visibleIssues(issues.data ?? []).map(i => (
            <CommandItem
              key={issueId(i)}
              // Its connection too: one key and title on two trackers are two options, never one.
              value={`${i.key} ${i.summary} ${issueId(i)}`}
              onSelect={() => go(issuePath(i))}
            >
              <span className="mr-2 text-caption text-muted-foreground">
                {i.key}
              </span>
              <span className="truncate">{i.summary}</span>
              {i.favorite === 1 && (
                <span className="ml-2 text-warning" aria-label={t("ui.palette.favorite")}>
                  ★
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        {extra.length > 0 && (
          <CommandGroup heading={t("ui.palette.moreIssues")}>
            {extra.map(i => (
              <CommandItem key={issueId(i)} value={`${i.key} ${i.summary} ${issueId(i)}`} onSelect={() => go(issuePath(i))}>
                <span className="mr-2 text-caption text-muted-foreground">{i.key}</span>
                <span className="truncate">{i.summary}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {buckets.buckets.length > 0 && (
          <CommandGroup heading={t("ui.palette.buckets")}>
            <CommandItem value={`bucket ${t("ui.buckets.everything")}`} onSelect={() => { buckets.choose(null); setOpen(false); }}>
              <Layers className="mr-2 h-4 w-4" />
              {t("ui.palette.showBucket", { name: t("ui.buckets.everything") })}
              {buckets.active === null && <span className="ml-auto text-caption text-muted-foreground">✓</span>}
            </CommandItem>
            {buckets.buckets.map(b => (
              <CommandItem key={b.id} value={`bucket ${b.name}`} onSelect={() => { buckets.choose(b.id); setOpen(false); }}>
                <Layers className="mr-2 h-4 w-4" />
                {t("ui.palette.showBucket", { name: b.name })}
                {buckets.active?.id === b.id && <span className="ml-auto text-caption text-muted-foreground">✓</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading={t("ui.palette.navigation")}>
          <CommandItem onSelect={() => go("/")}>
            <LayoutDashboard className="mr-2 h-4 w-4" /> {t("ui.nav.dashboard")}
          </CommandItem>
          <CommandItem onSelect={() => go("/issues")}>
            <ListTodo className="mr-2 h-4 w-4" /> {t("ui.nav.issues")}
          </CommandItem>
          <CommandItem value={`${t("ui.palette.openDesk")} ${t("ui.nav.desk")}`} onSelect={() => go("/issues/desk")}>
            <LayoutPanelLeft className="mr-2 h-4 w-4" /> {t("ui.palette.openDesk")}
            <Kbd className="ml-auto text-muted-foreground">G E</Kbd>
          </CommandItem>
          <CommandItem onSelect={() => go("/notes")}>
            <NotebookPen className="mr-2 h-4 w-4" /> {t("ui.nav.notes")}
            <Kbd className="ml-auto text-muted-foreground">G N</Kbd>
          </CommandItem>
          <CommandItem onSelect={() => go("/timesheet")}>
            <CalendarDays className="mr-2 h-4 w-4" /> {t("ui.nav.timesheet")}
          </CommandItem>
          <CommandItem onSelect={() => go("/ideas")}>
            <Lightbulb className="mr-2 h-4 w-4" /> {t("ui.nav.ideas")}
          </CommandItem>
          <CommandItem onSelect={() => go("/board")}>
            <KanbanSquare className="mr-2 h-4 w-4" /> {t("ui.nav.board")}
          </CommandItem>
          <CommandItem onSelect={() => go("/reports")}>
            <BarChart3 className="mr-2 h-4 w-4" /> {t("ui.nav.reports")}
          </CommandItem>
          <CommandItem onSelect={() => go("/settings")}>
            <SettingsIcon className="mr-2 h-4 w-4" /> {t("ui.nav.settings")}
          </CommandItem>
          <CommandItem onSelect={() => go("/info")}>
            <InfoIcon className="mr-2 h-4 w-4" /> {t("ui.nav.info")}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t("ui.palette.actions")}>
          {open && <AddToDeskCommand pathname={pathname} onDone={() => setOpen(false)} />}
          <CommandItem
            onSelect={() => {
              setOpen(false);
              dayReview.set(true);
            }}
          >
            <Sunset className="mr-2 h-4 w-4" /> {t("ui.palette.closeDay")}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              focusMode.set(true);
            }}
          >
            <Maximize2 className="mr-2 h-4 w-4" /> {t("ui.palette.focusMode")}
            <Kbd className="ml-auto text-muted-foreground">
              F
            </Kbd>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              screensaver.set(true);
            }}
          >
            <Sparkles className="mr-2 h-4 w-4" /> {t("ui.palette.screensaver")}
            <Kbd className="ml-auto text-muted-foreground">Z</Kbd>
          </CommandItem>
          <CommandItem onSelect={() => go(`/notes/new?draft=${newDraftId()}`)}>
            <NotebookPen className="mr-2 h-4 w-4" /> {t("ui.palette.newNote")}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              ideaCapture.set(true);
            }}
          >
            <Lightbulb className="mr-2 h-4 w-4" /> {t("ui.palette.newIdea")}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openPinMail();
            }}
          >
            <MailPlus className="mr-2 h-4 w-4" /> {t("ui.palette.pinMail")}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              createIssueDialog.set(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> {t("ui.palette.newIssue")}
            <Kbd className="ml-auto text-muted-foreground">I</Kbd>
          </CommandItem>
          {pinTarget !== null && (
            <CommandItem
              onSelect={() => {
                setOpen(false);
                requestAnimationFrame(() => togglePinboard());
              }}
            >
              <Pin className="mr-2 h-4 w-4 -rotate-12" /> {t("ui.palette.pinboard")}
              <Kbd className="ml-auto text-muted-foreground">P</Kbd>
            </CommandItem>
          )}
          {todoTarget !== null && (
            <CommandItem
              onSelect={() => {
                setOpen(false);
                requestAnimationFrame(() => toggleTodos());
              }}
            >
              <ListChecks className="mr-2 h-4 w-4" /> {t("ui.palette.todos")}
              <Kbd className="ml-auto text-muted-foreground">D</Kbd>
            </CommandItem>
          )}
          <MoveTimerCommand onDone={() => setOpen(false)} />
          <CommandItem
            onSelect={() => {
              setOpen(false);
              quickStart.set(true);
            }}
          >
            <Play className="mr-2 h-4 w-4" /> {t("ui.palette.startTimer")}
            <Kbd className="ml-auto text-muted-foreground">
              T
            </Kbd>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              sync.mutate();
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> {t("ui.palette.syncJira", { provider })}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              shortcutsHelp.set(true);
            }}
          >
            <Keyboard className="mr-2 h-4 w-4" /> {t("ui.palette.shortcuts")}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
              setOpen(false);
            }}
          >
            {resolvedTheme === "dark" ? (
              <Sun className="mr-2 h-4 w-4" />
            ) : (
              <Moon className="mr-2 h-4 w-4" />
            )}
            {t("ui.palette.toggleTheme")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="flex items-center gap-4 border-t px-3 py-2 text-caption text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd className="px-1">↑</Kbd>
          <Kbd className="px-1">↓</Kbd> {t("ui.palette.navigate")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>{t("ui.keys.enter")}</Kbd>{" "}
          {t("ui.palette.open")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd>{" "}
          {t("ui.palette.close")}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>?</Kbd>{" "}
          {t("ui.palette.shortcutsHint")}
        </span>
      </div>
    </>
  );
}

/**
 * On an issue's page: "Add KEY to desk". The server puts it there (a full desk parks
 * its last pane); a toast says what happened and goes to the desk.
 */
function AddToDeskCommand({ pathname, onDone }: { pathname: string; onDone: () => void }) {
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
  return (
    <CommandItem
      value={label}
      onSelect={() => {
        onDone();
        add.mutate(target);
      }}
    >
      <LayoutPanelLeft className="mr-2 h-4 w-4" /> {label}
    </CommandItem>
  );
}

/**
 * The timer at hand (running, else the last paused), moved to another issue
 * from here too. Its own component: only the open palette follows the timers.
 */
function MoveTimerCommand({ onDone }: { onDone: () => void }) {
  const { timers } = useTimers();
  const current = timers.find(tm => tm.state === "running") ?? timers[0];
  return current ? <MoveTimerItem key={issueId(current)} issueKey={current.issueKey} connectionId={current.connectionId} onDone={onDone} /> : null;
}

/**
 * The timer's own commands, as its buttons have them: pause or resume, stop and log (the usual
 * log dialog, with its issue and time), move to another issue. Keyboard first, from any page.
 */
function MoveTimerItem({ issueKey, connectionId, onDone }: { issueKey: string; connectionId: number; onDone: () => void }) {
  const { move, pause, start, stop, running, paused, heldElsewhere } = useTimerActions(issueKey, connectionId);
  if (heldElsewhere) return null;
  const item = (label: string, icon: React.ReactNode, act: () => void) => (
    <CommandItem
      value={label}
      onSelect={() => {
        onDone();
        act();
      }}
    >
      {icon} {label}
    </CommandItem>
  );
  return (
    <>
      {running && item(t("ui.timer.pauseFor", { key: issueKey }), <Pause className="mr-2 h-4 w-4" />, pause)}
      {paused && item(t("ui.timer.resumeFor", { key: issueKey }), <Play className="mr-2 h-4 w-4" />, start)}
      {(running || paused) && item(t("ui.timer.stopAndLogFor", { key: issueKey }), <Square className="mr-2 h-4 w-4" />, stop)}
      {item(t("ui.timer.moveToFor", { key: issueKey }), <MoveRight className="mr-2 h-4 w-4" />, move)}
    </>
  );
}
