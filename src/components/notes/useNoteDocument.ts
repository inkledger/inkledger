import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NoteDocument, NoteIssue, NoteTreeItem } from "@contracts/notes";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { errorText } from "@/lib/errorText";
import {
  deleteDraft,
  findDraft,
  listDrafts,
  noteTabId,
  storageProbe,
  writeDraft,
  type NoteDraft,
} from "./drafts";
import { onServerNote, setNoteDirty } from "./noteSync";

export type SaveState =
  "draft" | "saving" | "saved" | "offline" | "error" | "conflict";

type Options = {
  noteId: string | null;
  identity: string;
  draftId: string;
  recoverAnyDraft?: boolean;
  parentId: string | null;
  issue: NoteIssue | null;
  onCreated: (note: NoteDocument) => void;
};

const meaningful = (title: string, body: string) =>
  title.trim().length > 0 || body.trim().length > 0;

export function useNoteDocument(options: Options) {
  const { user } = useAuth();
  const userId = user?.id ?? 0;
  const utils = trpc.useUtils();
  const [currentId, setCurrentId] = useState(options.noteId);
  const currentIdRef = useRef(currentId);
  const query = trpc.notes.get.useQuery(
    {
      id: currentId ?? options.noteId ?? "00000000-0000-0000-0000-000000000000",
    },
    { enabled: !!(currentId ?? options.noteId), retry: false }
  );
  const [confirmed, setConfirmed] = useState<NoteDocument | null>(null);
  const confirmedRef = useRef<NoteDocument | null>(null);
  const [title, setTitleState] = useState("");
  const [body, setBodyState] = useState("");
  const [status, setStatus] = useState<SaveState>("draft");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<NoteDocument | null>(null);
  const conflictRef = useRef<NoteDocument | null>(null);
  const [recovery, setRecovery] = useState<NoteDraft | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(
    () => !storageProbe()
  );
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ title: "", body: "" });
  const baseRevision = useRef(0);
  const sequence = useRef(0);
  const saving = useRef<Promise<NoteDocument | null> | null>(null);
  const generation = useRef(0);
  const saveRequested = useRef(false);
  const activeDraftId = useRef(options.draftId);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const setConfirmedNote = useCallback((note: NoteDocument | null) => {
    confirmedRef.current = note;
    baseRevision.current = note?.contentRevision ?? 0;
    setConfirmed(note);
  }, []);

  const cacheNote = useCallback(
    (note: NoteDocument) => {
      utils.notes.get.setData({ id: note.id }, note);
      utils.notes.tree.setData(undefined, old =>
        old?.map(item =>
          item.id === note.id
            ? {
                ...item,
                title: note.title,
                contentRevision: note.contentRevision,
                updatedAt: note.updatedAt,
                connectionId: note.connectionId,
                issueKey: note.issueKey,
              }
            : item
        )
      );
    },
    [utils]
  );

  useEffect(() => {
    const route = optionsRef.current;
    generation.current += 1;
    saving.current = null;
    saveRequested.current = false;
    currentIdRef.current = route.noteId;
    activeDraftId.current = route.draftId;
    confirmedRef.current = null;
    conflictRef.current = null;
    latest.current = { title: "", body: "" };
    baseRevision.current = 0;
    setCurrentId(route.noteId);
    setConfirmed(null);
    setTitleState("");
    setBodyState("");
    setConflict(null);
    setRecovery(null);
    setError(null);
    setStatus("draft");
    setBusy(false);
    setLoaded(false);
  }, [options.identity]);

  useEffect(() => {
    if (
      loaded ||
      !userId ||
      (options.noteId && query.data?.id !== options.noteId)
    )
      return;
    const server = options.noteId ? (query.data ?? null) : null;
    const local =
      findDraft(userId, options.noteId, activeDraftId.current) ??
      (options.noteId && options.recoverAnyDraft
        ? listDrafts(userId).find(draft => draft.noteId === options.noteId)
        : null);
    if (local) activeDraftId.current = local.draftId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initialize the editor once from the async document and its local recovery draft.
    setConfirmedNote(server);
    if (server) {
      cacheNote(server);
      latest.current = { title: server.title, body: server.body };
      setTitleState(server.title);
      setBodyState(server.body);
      setStatus("saved");
    }
    if (local && meaningful(local.title, local.body) && !server) {
      latest.current = { title: local.title, body: local.body };
      baseRevision.current = local.baseContentRevision;
      setTitleState(local.title);
      setBodyState(local.body);
      setStatus("draft");
    } else if (
      local &&
      server &&
      meaningful(local.title, local.body) &&
      local.baseContentRevision !== server.contentRevision
    ) {
      latest.current = { title: local.title, body: local.body };
      setTitleState(local.title);
      setBodyState(local.body);
      conflictRef.current = server;
      setConflict(server);
      setStatus("conflict");
    } else if (
      local &&
      server &&
      (local.title !== server.title || local.body !== server.body)
    ) {
      setRecovery(local);
    } else if (local) {
      deleteDraft(local);
    }
    setLoaded(true);
  }, [
    cacheNote,
    loaded,
    options.noteId,
    options.recoverAnyDraft,
    query.data,
    setConfirmedNote,
    userId,
  ]);

  const dirty =
    loaded &&
    !recovery &&
    (confirmed
      ? title !== confirmed.title || body !== confirmed.body
      : meaningful(title, body));

  useEffect(() => {
    if (currentId) setNoteDirty(currentId, dirty || status === "saving");
    return () => {
      if (currentId) setNoteDirty(currentId, false);
    };
  }, [currentId, dirty, status]);

  const persistDraft = useCallback(() => {
    if (!userId || !loaded || !dirty) return true;
    const draft: NoteDraft = {
      version: 1,
      userId,
      noteId: currentIdRef.current,
      draftId: activeDraftId.current,
      tabId: noteTabId(),
      baseContentRevision: baseRevision.current,
      title: latest.current.title,
      body: latest.current.body,
      parentId: optionsRef.current.parentId,
      issue: optionsRef.current.issue,
      updatedAt: Date.now(),
    };
    const ok = writeDraft(draft);
    setStorageUnavailable(!ok);
    return ok;
  }, [dirty, loaded, userId]);

  const clearMatchingDraft = useCallback(
    (savedTitle: string, savedBody: string) => {
      if (!userId) return;
      const local =
        findDraft(userId, currentIdRef.current, activeDraftId.current) ??
        findDraft(userId, null, activeDraftId.current);
      if (local && local.title === savedTitle && local.body === savedBody)
        deleteDraft(local);
    },
    [userId]
  );

  const flush = useCallback((): Promise<NoteDocument | null> => {
    saveRequested.current = true;
    if (saving.current) return saving.current;
    if (
      conflictRef.current ||
      !loaded ||
      (!currentIdRef.current &&
        !meaningful(latest.current.title, latest.current.body))
    )
      return Promise.resolve(confirmedRef.current);
    const runGeneration = generation.current;
    const hasChanges = () =>
      !confirmedRef.current ||
      latest.current.title !== confirmedRef.current.title ||
      latest.current.body !== confirmedRef.current.body;
    const canSave = () =>
      !!currentIdRef.current ||
      meaningful(latest.current.title, latest.current.body);
    const run = (async () => {
      await Promise.resolve();
      setBusy(true);
      setError(null);
      try {
        while (
          runGeneration === generation.current &&
          canSave() &&
          hasChanges()
        ) {
          saveRequested.current = false;
          if (conflictRef.current) break;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            setStatus("offline");
            break;
          }
          const captured = { ...latest.current };
          const capturedSequence = sequence.current;
          const id = currentIdRef.current;
          setStatus("saving");
          try {
            let note: NoteDocument;
            if (!id) {
              note = await utils.client.notes.create.mutate({
                ...captured,
                parentId: optionsRef.current.parentId,
                issue: optionsRef.current.issue,
              });
              if (runGeneration !== generation.current) break;
              currentIdRef.current = note.id;
              setCurrentId(note.id);
              optionsRef.current.onCreated(note);
              await utils.notes.tree.invalidate();
            } else {
              const result = await utils.client.notes.updateContent.mutate({
                id,
                ...captured,
                expectedRevision: baseRevision.current,
              });
              if (runGeneration !== generation.current) break;
              if (result.status === "conflict") {
                conflictRef.current = result.current;
                setConflict(result.current);
                setConfirmedNote(result.current);
                setStatus("conflict");
                break;
              }
              note = result.note;
            }
            if (runGeneration !== generation.current) break;
            setConfirmedNote(note);
            cacheNote(note);
            if (sequence.current === capturedSequence) {
              setStatus("saved");
              clearMatchingDraft(captured.title, captured.body);
            } else {
              setStatus("draft");
            }
            if (conflictRef.current) break;
            if (
              latest.current.title === note.title &&
              latest.current.body === note.body &&
              !saveRequested.current
            )
              break;
          } catch (cause) {
            if (runGeneration === generation.current) {
              setError(errorText(cause));
              setStatus(
                typeof navigator !== "undefined" && navigator.onLine === false
                  ? "offline"
                  : "error"
              );
            }
            break;
          }
        }
      } finally {
        if (runGeneration === generation.current) {
          saving.current = null;
          setBusy(false);
        }
      }
      return runGeneration === generation.current ? confirmedRef.current : null;
    })();
    saving.current = run;
    return run;
  }, [cacheNote, clearMatchingDraft, loaded, setConfirmedNote, utils]);

  const change = useCallback((kind: "title" | "body", value: string) => {
    sequence.current += 1;
    latest.current = { ...latest.current, [kind]: value };
    if (kind === "title") setTitleState(value);
    else setBodyState(value);
    setStatus(conflictRef.current ? "conflict" : "draft");
    setError(null);
  }, []);

  const setTitle = useCallback(
    (value: string) => change("title", value),
    [change]
  );
  const setBody = useCallback(
    (value: string) => change("body", value),
    [change]
  );

  useEffect(() => {
    if (!dirty || conflict) return;
    const draftTimer = setTimeout(persistDraft, 200);
    const saveTimer = setTimeout(() => void flush(), 1000);
    return () => {
      clearTimeout(draftTimer);
      clearTimeout(saveTimer);
    };
  }, [body, conflict, dirty, flush, persistDraft, title]);

  useEffect(() => {
    const retry = () => {
      if (dirty && !conflictRef.current) void flush();
    };
    const focus = () => {
      if (document.visibilityState === "visible") retry();
    };
    const hide = () => {
      persistDraft();
      if (dirty && !conflictRef.current) void flush();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (storageUnavailable && dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("pagehide", hide);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("beforeunload", unload);
      persistDraft();
      if (dirty && !conflictRef.current) void flush();
    };
  }, [dirty, flush, options.identity, persistDraft, storageUnavailable]);

  const acceptServer = useCallback(
    (note: NoteDocument) => {
      if (saving.current || note.contentRevision === baseRevision.current)
        return;
      const isDirty =
        latest.current.title !== confirmedRef.current?.title ||
        latest.current.body !== confirmedRef.current?.body;
      if (isDirty) {
        conflictRef.current = note;
        setConflict(note);
        setStatus("conflict");
      } else {
        setConfirmedNote(note);
        latest.current = { title: note.title, body: note.body };
        setTitleState(note.title);
        setBodyState(note.body);
        setStatus("saved");
        cacheNote(note);
      }
    },
    [cacheNote, setConfirmedNote]
  );

  useEffect(() => {
    if (!currentId) return;
    return onServerNote(currentId, acceptServer);
  }, [acceptServer, currentId]);

  useEffect(() => {
    if (loaded && currentId && query.data?.id === currentId)
      acceptServer(query.data);
  }, [acceptServer, currentId, loaded, query.data]);

  const recover = useCallback(() => {
    if (!recovery) return;
    latest.current = { title: recovery.title, body: recovery.body };
    sequence.current += 1;
    setTitleState(recovery.title);
    setBodyState(recovery.body);
    setRecovery(null);
    setStatus("draft");
  }, [recovery]);

  const discardRecovery = useCallback(() => {
    if (recovery) deleteDraft(recovery);
    setRecovery(null);
  }, [recovery]);

  const useServer = useCallback(() => {
    const note = conflictRef.current;
    if (!note) return;
    const local = findDraft(
      userId,
      currentIdRef.current,
      activeDraftId.current
    );
    if (local) deleteDraft(local);
    latest.current = { title: note.title, body: note.body };
    sequence.current += 1;
    setConfirmedNote(note);
    setTitleState(note.title);
    setBodyState(note.body);
    conflictRef.current = null;
    setConflict(null);
    setStatus("saved");
  }, [setConfirmedNote, userId]);

  const saveCopy = useCallback(async () => {
    const note = await utils.client.notes.create.mutate({
      ...latest.current,
      parentId: optionsRef.current.parentId,
      issue: optionsRef.current.issue,
    });
    await utils.notes.tree.invalidate();
    return note;
  }, [utils]);

  const overwrite = useCallback(async () => {
    const current = conflictRef.current;
    const id = currentIdRef.current;
    if (!current || !id) return null;
    setBusy(true);
    try {
      const result = await utils.client.notes.updateContent.mutate({
        id,
        ...latest.current,
        expectedRevision: current.contentRevision,
      });
      if (result.status === "conflict") {
        conflictRef.current = result.current;
        setConflict(result.current);
        setConfirmedNote(result.current);
        return null;
      }
      setConfirmedNote(result.note);
      cacheNote(result.note);
      conflictRef.current = null;
      setConflict(null);
      setStatus("saved");
      clearMatchingDraft(latest.current.title, latest.current.body);
      return result.note;
    } finally {
      setBusy(false);
    }
  }, [cacheNote, clearMatchingDraft, setConfirmedNote, utils]);

  const applyRestored = useCallback(
    (note: NoteDocument) => {
      latest.current = { title: note.title, body: note.body };
      sequence.current += 1;
      setConfirmedNote(note);
      cacheNote(note);
      setTitleState(note.title);
      setBodyState(note.body);
      conflictRef.current = null;
      setConflict(null);
      setStatus("saved");
    },
    [cacheNote, setConfirmedNote]
  );

  const applyMetadata = useCallback(
    (item: NoteTreeItem) => {
      const current = confirmedRef.current;
      if (!current || current.id !== item.id) return;
      const note = {
        ...current,
        ...item,
        body: current.body,
        doc: current.doc,
      };
      setConfirmedNote(note);
      cacheNote(note);
    },
    [cacheNote, setConfirmedNote]
  );

  return {
    note: confirmed,
    currentId,
    title,
    body,
    setTitle,
    setBody,
    status,
    error,
    busy,
    dirty,
    conflict,
    recovery,
    storageUnavailable,
    isLoading: !!options.noteId && query.isPending && !loaded,
    loadError: query.error,
    retryLoad: query.refetch,
    flush,
    persistDraft,
    recover,
    discardRecovery,
    useServer,
    saveCopy,
    overwrite,
    applyRestored,
    applyMetadata,
    isCurrent: (note: NoteDocument | null) =>
      !!note &&
      latest.current.title === note.title &&
      latest.current.body === note.body,
    getConflict: () => conflictRef.current,
    reportConflict: (current: NoteDocument) => {
      conflictRef.current = current;
      setConflict(current);
      setConfirmedNote(current);
      setStatus("conflict");
    },
  };
}

export type NoteDocumentController = ReturnType<typeof useNoteDocument>;
export type NoteMetadata = NoteTreeItem;

export function NoteController({
  options,
  children,
}: {
  options: Options;
  children: (controller: NoteDocumentController) => ReactNode;
}) {
  return children(useNoteDocument(options));
}
