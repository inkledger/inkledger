import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { BookOpen, ChevronLeft, FilePlus2, Plus, Search, Trash2 } from "lucide-react";
import {
  NOTE_FILTERS,
  NOTE_SEARCH_MAX,
  NOTE_SEARCH_MIN,
  type NoteDocument,
  type NoteFilter,
  type NoteIssue,
} from "@contracts/notes";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelRow } from "@/components/app/Panel";
import { EmptyState, ErrorState, PageSpinner } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useUrlFields } from "@/hooks/useUrlState";
import { oneOf, text, type Fields } from "@/lib/urlCodecs";
import { errorText } from "@/lib/errorText";
import { isDialogOpen, isTyping } from "@/lib/dom";
import { readStoredJson, writeStored } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { NoteTree } from "@/components/notes/NoteTree";
import { NoteSearchResults } from "@/components/notes/NoteSearchResults";
import { LocalDrafts } from "@/components/notes/LocalDrafts";
import { NoteEditor } from "@/components/notes/NoteEditor";
import { NoteActions } from "@/components/notes/NoteActions";
import { SaveStatus } from "@/components/notes/SaveStatus";
import { NoteDiary } from "@/components/notes/NoteDiary";
import { NoteTrash } from "@/components/notes/NoteTrash";
import { ancestorIds, folderTarget } from "@/components/notes/treeModel";
import { FolderView } from "@/components/notes/FolderView";
import { newNotePath } from "@/components/notes/paths";
import {
  listDrafts,
  newDraftId,
  type NoteDraft,
} from "@/components/notes/drafts";
import { NoteController } from "@/components/notes/useNoteDocument";
import { NOTE_DATE_CHIPS, parseNoteQuery } from "@contracts/noteQuery";
import { ToggleChip } from "@/components/app/ToggleChip";

const fields: Fields<{
  q: string;
  filter: NoteFilter;
  mode: "tree" | "search";
}> = {
  q: { key: "q", fallback: "", codec: text },
  filter: { key: "filter", fallback: "all", codec: oneOf(NOTE_FILTERS) },
  mode: {
    key: "mode",
    fallback: "tree",
    codec: oneOf(["tree", "search"] as const),
  },
};

export default function NotesPage() {
  const { noteId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? 0;
  const isNew = location.pathname === "/notes/new";
  const isTrash = location.pathname === "/notes/trash";
  const isDiary = location.pathname === "/notes/diary";
  const params = useMemo(
    () => new URLSearchParams(location.search),
    [location.search]
  );
  const draftParam = params.get("draft");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one local recovery id per document route.
  const generatedDraftId = useMemo(() => newDraftId(), [location.pathname]);
  const draftId =
    draftParam && /^[a-zA-Z0-9-]{8,80}$/.test(draftParam)
      ? draftParam
      : generatedDraftId;
  const parentParam = params.get("parentId");
  const issueKey = params.get("issueKey");
  const connectionId = Number(params.get("connectionId"));
  const initialIssue: NoteIssue | null =
    issueKey && Number.isInteger(connectionId) && connectionId > 0
      ? { issueKey, connectionId }
      : null;
  const [{ q, filter }, setUrl] = useUrlFields(fields);
  const tree = trpc.notes.tree.useQuery(undefined, { enabled: !isTrash });
  // `data:ieri`, `creata:7d`… read here, where the user's days are; the rest is words.
  const parsed = useMemo(() => parseNoteQuery(q.slice(0, NOTE_SEARCH_MAX), new Date()), [q]);
  const queryText = parsed.text;
  const searching = queryText.length >= NOTE_SEARCH_MIN || parsed.dates.length > 0;
  const search = trpc.notes.search.useInfiniteQuery(
    { query: queryText, dates: parsed.dates, filter, limit: 30 },
    {
      enabled: searching && !isTrash,
      retry: false,
      getNextPageParam: last => last.nextCursor ?? undefined,
    }
  );
  const results = search.data?.pages.flatMap(page => page.results) ?? [];
  const searchRef = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<NoteDraft[]>([]);
  const expansionKey = `ikl-note-expanded:v1:${userId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = readStoredJson(expansionKey);
    return new Set(
      Array.isArray(saved)
        ? saved.filter((value): value is string => typeof value === "string")
        : []
    );
  });
  const selected = noteId
    ? tree.data?.find(item => item.id === noteId)
    : undefined;
  // The note or folder opened is revealed once (its branch opened); after that
  // each folder opens and closes only by hand, never because another one did.
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const notedOnParam = params.get("notedOn");
  const initialNotedOn = isNew && notedOnParam && /^\d{4}-\d{2}-\d{2}$/.test(notedOnParam) ? notedOnParam : undefined;
  const initialParent =
    isNew && parentParam && /^[0-9a-f-]{36}$/i.test(parentParam)
      ? parentParam
      : null;
  const parentId = isNew ? initialParent : (selected?.parentId ?? null);
  const noteIssue = isNew
    ? initialIssue
    : selected?.connectionId && selected.issueKey
      ? { connectionId: selected.connectionId, issueKey: selected.issueKey }
      : null;
  const identity = isNew || draftParam ? draftId : (noteId ?? "empty");
  const controllerOptions = {
    noteId: isNew ? null : (noteId ?? null),
    identity,
    draftId,
    recoverAnyDraft: !draftParam,
    parentId,
    issue: noteIssue,
    notedOn: initialNotedOn,
    onCreated: (note: NoteDocument) => {
      const next = new URLSearchParams(location.search);
      next.set("draft", draftId);
      next.set("view", "edit");
      next.delete("parentId");
      next.delete("notedOn");
      next.delete("issueKey");
      next.delete("connectionId");
      void navigate(`/notes/${note.id}?${next}`, { replace: true });
    },
  };

  // What leads to the open note or folder is shown, and an open folder shows what it holds.
  // (Once it is in the tree: a note just made may come with the next read.)
  if (noteId && tree.data && selected && revealedFor !== noteId) {
    setRevealedFor(noteId);
    const reveal = [...ancestorIds(tree.data, noteId), ...(selected?.kind === "folder" ? [noteId] : [])];
    if (reveal.some(id => !expanded.has(id))) setExpanded(new Set([...expanded, ...reveal]));
  }
  const shownExpanded = expanded;

  useEffect(() => {
    const refresh = () => setDrafts(userId ? listDrafts(userId) : []);
    refresh();
    const timer = setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [location.pathname, userId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target) ||
        isDialogOpen()
      )
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (isTrash) return <NoteTrash />;
  if (isDiary) return <NoteDiary />;
  if ((isNew || draftParam) && draftParam !== draftId) {
    const next = new URLSearchParams(location.search);
    next.set("draft", draftId);
    return <Navigate to={`${location.pathname}?${next}`} replace />;
  }

  const expand = (id: string) => {
    setExpanded(previous => {
      if (previous.has(id)) return previous;
      const next = new Set(previous).add(id);
      writeStored(expansionKey, JSON.stringify([...next]));
      return next;
    });
  };
  const toggle = (id: string) => {
    const closing = expanded.has(id);
    setExpanded(previous => {
      const next = new Set(previous);
      if (closing) next.delete(id);
      else next.add(id);
      writeStored(expansionKey, JSON.stringify([...next]));
      return next;
    });
  };
  const hasDocument = isNew || !!noteId;
  const openFolder = selected?.kind === "folder" ? selected : undefined;
  // The folders and notes on the way to the open one, as breadcrumb steps.
  const trail =
    noteId && tree.data
      ? ancestorIds(tree.data, noteId)
          .reverse()
          .flatMap(id => {
            const step = tree.data?.find(item => item.id === id);
            return step ? [{ label: step.title || t("pages.notes.untitled"), to: `/notes/${step.id}${location.search}` }] : [];
          })
      : [];
  // "New" goes into the folder on screen, or the one holding the open note.
  const newHere = newNotePath(folderTarget(tree.data ?? [], noteId));
  const treeError = tree.error;

  return (
    <NoteController key={identity} options={controllerOptions}>
      {controller => {
        // A folder's name is the tree's (it has no document of its own to load).
        const title = openFolder
          ? openFolder.title || t("pages.notes.untitled")
          : hasDocument
            ? controller.title || t("pages.notes.untitled")
            : t("pages.notes.title");
        return (
          <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
            <PageHeader
              title={title}
              documentTitle={hasDocument ? title : t("pages.notes.title")}
              breadcrumbCurrent={hasDocument ? title : undefined}
              breadcrumbTrail={trail}
              description={t("pages.notes.description")}
              titleClassName="truncate"
              className="min-h-[10rem] sm:min-h-[8rem] xl:min-h-[5rem]"
              actions={
                <>
                  {hasDocument && !openFolder && (
                    <SaveStatus
                      status={controller.status}
                      savedAt={controller.note?.updatedAt}
                      storageUnavailable={controller.storageUnavailable}
                    />
                  )}
                  <Button asChild size="sm">
                    <Link to={newHere}>
                      <Plus />
                      {t("pages.notes.new")}
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/notes/diary">
                      <BookOpen />
                      {t("pages.notes.diary.title")}
                    </Link>
                  </Button>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("pages.notes.trash")}
                    title={t("pages.notes.trash")}
                  >
                    <Link to="/notes/trash">
                      <Trash2 />
                    </Link>
                  </Button>
                </>
              }
            />
            <PanelRow className="min-h-0 flex-1 lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-1">
              <aside
                data-scroll-key="notes-tree"
                className={cn(
                  "min-w-0 border-b lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r",
                  hasDocument && "max-lg:hidden"
                )}
              >
                <div className="grid grid-cols-[minmax(0,1fr)] gap-2 p-3">
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      ref={searchRef}
                      type="search"
                      value={q}
                      maxLength={NOTE_SEARCH_MAX}
                      onChange={event => {
                        setUrl({
                          q: event.target.value,
                          mode: event.target.value ? "search" : "tree",
                        });
                      }}
                      placeholder={t("pages.notes.search")}
                      aria-label={t("pages.notes.search")}
                      className="pl-8"
                    />
                  </div>
                  {/* One day or period at a time: a chip puts its date in the query (written there, it can be edited). */}
                  <div role="group" aria-label={t("pages.notes.byDate")} className="flex flex-wrap gap-1">
                    {NOTE_DATE_CHIPS.map(chip => {
                      const token = `date:${chip}`;
                      const on = q.split(/\s+/).includes(token);
                      return (
                        <ToggleChip
                          key={chip}
                          size="sm"
                          pressed={on}
                          onClick={() => {
                            const rest = q
                              .split(/\s+/)
                              .filter(w => w && !NOTE_DATE_CHIPS.some(c => w === `date:${c}`))
                              .join(" ");
                            const next = on ? rest : `${rest} ${token}`.trim();
                            setUrl({ q: next, mode: next ? "search" : "tree" });
                          }}
                        >
                          {t(`pages.notes.dateChip.${chip}`)}
                        </ToggleChip>
                      );
                    })}
                  </div>
                  {parsed.bad.length > 0 && (
                    <p className="text-caption text-warning">{t("pages.notes.notADate", { terms: parsed.bad.join(", ") })}</p>
                  )}
                  <Select
                    value={filter}
                    onValueChange={value => {
                      setUrl({ filter: value as NoteFilter });
                    }}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t("pages.notes.filter")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {t("pages.notes.filterAll")}
                      </SelectItem>
                      <SelectItem value="free">
                        {t("pages.notes.filterFree")}
                      </SelectItem>
                      <SelectItem value="linked">
                        {t("pages.notes.filterLinked")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {searching ? (
                  <div>
                    {search.isPending && !results.length ? (
                      <div className="grid gap-2 p-3">
                        <Skeleton className="h-16" />
                        <Skeleton className="h-16" />
                      </div>
                    ) : search.error ? (
                      <ErrorState
                        message={errorText(search.error)}
                        onRetry={() => search.refetch()}
                      />
                    ) : !results.length && !search.isFetching ? (
                      <EmptyState
                        title={t("pages.notes.noResults")}
                        message={t("pages.notes.noResultsText")}
                      />
                    ) : (
                      <NoteSearchResults
                        results={results}
                        search={location.search}
                      />
                    )}
                    {search.hasNextPage && (
                      <div className="p-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          disabled={search.isFetchingNextPage}
                          onClick={() => void search.fetchNextPage()}
                        >
                          {search.isFetchingNextPage
                            ? t("pages.notes.loading")
                            : t("pages.notes.loadMore")}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : tree.isPending ? (
                  <div className="grid gap-2 p-3">
                    <Skeleton className="h-9" />
                    <Skeleton className="h-9" />
                    <Skeleton className="h-9" />
                  </div>
                ) : treeError ? (
                  <ErrorState
                    message={errorText(treeError)}
                    onRetry={() => tree.refetch()}
                  />
                ) : (
                  <NoteTree
                    items={tree.data}
                    selectedId={noteId}
                    expanded={shownExpanded}
                    toggle={toggle}
                    expand={expand}
                    search={location.search}
                    beforeDelete={async ids => {
                      // The open note goes too: its last typing is saved first, never lost to a conflict.
                      if (!noteId || !ids.has(noteId) || openFolder) return true;
                      const saved = await controller.flush();
                      return controller.isCurrent(saved) && !controller.getConflict();
                    }}
                    onDeleted={ids => {
                      if (noteId && ids.has(noteId)) void navigate(`/notes${location.search}`);
                    }}
                    empty={
                      <EmptyState
                        art="inbox"
                        title={t("pages.notes.empty")}
                        message={t("pages.notes.emptyText")}
                        action={
                          <Button asChild size="sm">
                            <Link to={newNotePath()}>
                              {t("pages.notes.createFirst")}
                            </Link>
                          </Button>
                        }
                      />
                    }
                  />
                )}
                {queryText.length === 1 && parsed.dates.length === 0 && (
                  <p className="px-4 pb-3 text-caption text-muted-foreground">
                    {t("pages.notes.searchMinimum")}
                  </p>
                )}
                <LocalDrafts
                  drafts={drafts}
                  remove={() => setDrafts(listDrafts(userId))}
                />
              </aside>
              <section
                data-scroll-key="notes-editor"
                aria-label={t("pages.notes.document")}
                className={cn(
                  "min-w-0 bg-card lg:flex lg:min-h-0 lg:flex-col lg:overflow-y-auto",
                  !hasDocument && "max-lg:hidden"
                )}
              >
                {!hasDocument ? (
                  <EmptyState
                    art="inbox"
                    title={t("pages.notes.choose")}
                    message={t("pages.notes.chooseText")}
                    action={
                      <Button asChild>
                        <Link to={newNotePath()}>
                          <FilePlus2 />
                          {t("pages.notes.new")}
                        </Link>
                      </Button>
                    }
                    className="my-auto py-24"
                  />
                ) : openFolder ? (
                  <FolderView folder={openFolder} items={tree.data ?? []} search={location.search} />
                ) : controller.isLoading ? (
                  <PageSpinner />
                ) : controller.loadError && !controller.note ? (
                  <ErrorState
                    title={t("pages.notes.notFound")}
                    message={errorText(controller.loadError)}
                    onRetry={() => controller.retryLoad()}
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 md:px-6">
                      <Link
                        to={`/notes${location.search}`}
                        className="inline-flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground lg:hidden"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        {t("pages.notes.title")}
                      </Link>
                    </div>
                    <NoteActions
                      controller={controller}
                      tree={tree.data ?? []}
                    />
                    <NoteEditor key={identity} controller={controller} />
                  </>
                )}
              </section>
            </PanelRow>
          </div>
        );
      }}
    </NoteController>
  );
}
