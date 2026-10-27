import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { ChevronLeft, FilePlus2, Plus, Search, Trash2 } from "lucide-react";
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
import { NoteTrash } from "@/components/notes/NoteTrash";
import { ancestorIds } from "@/components/notes/treeModel";
import {
  listDrafts,
  newDraftId,
  type NoteDraft,
} from "@/components/notes/drafts";
import { NoteController } from "@/components/notes/useNoteDocument";

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

function newNotePath(parentId?: string, issue?: NoteIssue | null): string {
  const params = new URLSearchParams({ draft: newDraftId() });
  if (parentId) params.set("parentId", parentId);
  if (issue) {
    params.set("issueKey", issue.issueKey);
    params.set("connectionId", String(issue.connectionId));
  }
  return `/notes/new?${params}`;
}

export default function NotesPage() {
  const { noteId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? 0;
  const isNew = location.pathname === "/notes/new";
  const isTrash = location.pathname === "/notes/trash";
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
  const queryText = q.trim().slice(0, NOTE_SEARCH_MAX);
  const searching = queryText.length >= NOTE_SEARCH_MIN;
  const search = trpc.notes.search.useInfiniteQuery(
    { query: queryText, filter, limit: 30 },
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
    onCreated: (note: NoteDocument) => {
      const next = new URLSearchParams(location.search);
      next.set("draft", draftId);
      next.set("view", "edit");
      next.delete("parentId");
      next.delete("issueKey");
      next.delete("connectionId");
      void navigate(`/notes/${note.id}?${next}`, { replace: true });
    },
  };

  const shownExpanded = new Set([
    ...expanded,
    ...(noteId && tree.data ? ancestorIds(tree.data, noteId) : []),
  ]);

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
  if ((isNew || draftParam) && draftParam !== draftId) {
    const next = new URLSearchParams(location.search);
    next.set("draft", draftId);
    return <Navigate to={`${location.pathname}?${next}`} replace />;
  }

  const toggle = (id: string) => {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeStored(expansionKey, JSON.stringify([...next]));
      return next;
    });
  };
  const hasDocument = isNew || !!noteId;
  const treeError = tree.error;

  return (
    <NoteController key={identity} options={controllerOptions}>
      {controller => {
        const title = hasDocument
          ? controller.title || t("pages.notes.untitled")
          : t("pages.notes.title");
        return (
          <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
            <PageHeader
              title={title}
              documentTitle={hasDocument ? title : t("pages.notes.title")}
              breadcrumbCurrent={hasDocument ? title : undefined}
              description={t("pages.notes.description")}
              titleClassName="truncate"
              className="min-h-[10rem] sm:min-h-[8rem] xl:min-h-[5rem]"
              actions={
                <>
                  {hasDocument && (
                    <SaveStatus
                      status={controller.status}
                      savedAt={controller.note?.updatedAt}
                      storageUnavailable={controller.storageUnavailable}
                    />
                  )}
                  <Button asChild size="sm">
                    <Link to={newNotePath()}>
                      <Plus />
                      {t("pages.notes.new")}
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
                <div className="grid gap-2 p-3">
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
                ) : !tree.data?.length ? (
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
                ) : (
                  <NoteTree
                    items={tree.data}
                    selectedId={noteId}
                    expanded={shownExpanded}
                    toggle={toggle}
                    search={location.search}
                  />
                )}
                {queryText.length === 1 && (
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
                      {selected && (
                        <Button
                          asChild
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                        >
                          <Link to={newNotePath(selected.id)}>
                            {t("pages.notes.newChild")}
                          </Link>
                        </Button>
                      )}
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
