import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Clock, CornerUpLeft, FileText, Hash, Paperclip, Pencil, SendHorizontal, X } from "lucide-react";
import { CHAT_BODY_MAX, CHAT_FILE_MAX_BYTES, CHAT_FILES_PER_MESSAGE, CHAT_REFS_MAX, CHAT_TYPING_EVERY_MS, chatPreview, type ChatFileView, type ChatMessageView, type ChatRef, type ChatThreadView } from "@contracts/chat";
import { formatDuration } from "@contracts/time";
import { IssuePicker } from "@/components/app/IssuePicker";
import { surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { readStored, writeStored } from "@/lib/storage";
import { clientId } from "@/lib/device";
import { formatBytes } from "@/lib/initials";
import { cn } from "@/lib/utils";
import { dateFormat, t } from "@/i18n";
import { nameIn } from "./chatText";

const HINT_ID = "chat-composer-hint";
const draftKey = (threadId: number) => `ikl-chat-draft-${threadId}`;

type Upload = { key: string; name: string; progress: number; file?: ChatFileView; error?: string };

/** One file into the thread, not sent yet (XMLHttpRequest: fetch has no upload progress). */
function uploadFile(threadId: number, file: File, onProgress: (p: number) => void): Promise<ChatFileView> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/chat/${threadId}/files`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-client-id", clientId());
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      const body = ((): unknown => {
        try {
          return JSON.parse(xhr.responseText) as unknown;
        } catch {
          return null;
        }
      })();
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === "object" && "id" in body) resolve(body as ChatFileView);
      else reject(new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : t("ui.upload.failed", { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t("ui.upload.offline")));
    xhr.send(form);
  });
}

/**
 * Where a member writes: Markdown text (Enter sends, Shift+Enter a new line, ↑ on an empty box
 * edits their last message), files dropped, pasted or picked (uploaded at once, with progress),
 * an issue or one of their worklogs as a card, the message it answers. What is typed is kept on
 * this device per thread until sent; the others see "is typing".
 */
export function Composer({
  thread,
  self,
  onSend,
  replyTo,
  onCancelReply,
  editing,
  onDoneEditing,
  lastOwn,
  onEditLast,
  autoFocus = false,
}: {
  thread: ChatThreadView;
  self: number | null;
  onSend: (draft: { body: string; refs: ChatRef[]; files: ChatFileView[]; replyToId?: number }) => void;
  replyTo: ChatMessageView | null;
  onCancelReply: () => void;
  editing: ChatMessageView | null;
  onDoneEditing: () => void;
  lastOwn: ChatMessageView | null;
  onEditLast: (m: ChatMessageView) => void;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => readStored(draftKey(thread.id)) ?? "");
  const [refs, setRefs] = useState<ChatRef[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const utils = trpc.useUtils();
  const typing = trpc.chat.typing.useMutation();
  const edit = trpc.chat.edit.useMutation({ onError: (e) => toastError(e) });
  const lastTyped = useRef(0);

  // The box grows with what is typed, up to its max height (then it scrolls).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  // Editing starts: the message's words in the box; it ends: the draft back (state follows the prop as it changes).
  const [seenEditing, setSeenEditing] = useState(editing);
  if (editing !== seenEditing) {
    setSeenEditing(editing);
    setText(editing ? editing.body : (readStored(draftKey(thread.id)) ?? ""));
  }
  // Editing: the box focused, the caret at the end.
  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [editing]);
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);
  // The draft kept on this device (not while editing: that is the message's own text).
  useEffect(() => {
    if (editing) return;
    const timer = setTimeout(() => writeStored(draftKey(thread.id), text.trim() ? text : null), 300);
    return () => clearTimeout(timer);
  }, [text, thread.id, editing]);

  const busy = uploads.some((u) => !u.file && !u.error);
  const files = uploads.flatMap((u) => (u.file ? [u.file] : []));
  // Sent while a file still uploads: it goes once the upload ends (never silently ignored).
  const [queued, setQueued] = useState(false);
  const ready = (editing ? text.trim().length > 0 || editing.refs.length > 0 || editing.files.length > 0 : text.trim().length > 0 || refs.length > 0 || uploads.some((u) => !u.error)) && text.length <= CHAT_BODY_MAX;

  const addFiles = (list: File[]) => {
    if (editing) return;
    const room = CHAT_FILES_PER_MESSAGE - uploads.length;
    for (const f of list.slice(0, Math.max(0, room))) {
      const key = `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`;
      if (f.size > CHAT_FILE_MAX_BYTES) {
        setUploads((u) => [...u, { key, name: f.name, progress: 0, error: t("server.chat.fileTooLarge", { name: f.name, mb: CHAT_FILE_MAX_BYTES / 1024 / 1024 }) }]);
        continue;
      }
      setUploads((u) => [...u, { key, name: f.name, progress: 0 }]);
      uploadFile(thread.id, f, (progress) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress } : x))))
        .then((file) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, file, progress: 100 } : x))))
        .catch((e: unknown) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: e instanceof Error ? e.message : String(e) } : x))));
    }
  };
  const dropUpload = (u: Upload) => {
    setUploads((list) => list.filter((x) => x.key !== u.key));
    // Uploaded but not sent: taken back on the server too (else it goes by itself in a day).
    if (u.file) void fetch(chatDraftUrl(u.file.id), { method: "DELETE", credentials: "same-origin", headers: { "x-client-id": clientId() } }).catch(() => undefined);
  };

  const canSend = !busy && ready;
  const submit = () => {
    if (busy && ready && !editing) {
      setQueued(true);
      return;
    }
    setQueued(false);
    if (!canSend) return;
    if (editing) {
      edit.mutate({ messageId: editing.id, body: text }, { onSuccess: () => void utils.chat.thread.invalidate({ threadId: thread.id }) });
      onDoneEditing();
      return;
    }
    onSend({ body: text, refs, files, replyToId: replyTo?.id });
    // The message ends the typing shown on the other side: the next keystroke says it again at once.
    lastTyped.current = 0;
    setText("");
    setRefs([]);
    setUploads([]);
    writeStored(draftKey(thread.id), null);
    onCancelReply();
  };

  const submitNow = useRef(submit);
  useEffect(() => {
    submitNow.current = submit;
  });
  useEffect(() => {
    if (queued && !busy) submitNow.current();
  }, [queued, busy]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && (editing || replyTo)) {
      e.preventDefault();
      if (editing) onDoneEditing();
      else onCancelReply();
    } else if (e.key === "ArrowUp" && !text && !editing && lastOwn) {
      e.preventDefault();
      onEditLast(lastOwn);
    }
  };

  const onType = (value: string) => {
    setText(value);
    const now = Date.now();
    if (value.trim() && !editing && now - lastTyped.current > CHAT_TYPING_EVERY_MS) {
      lastTyped.current = now;
      typing.mutate({ threadId: thread.id });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length === 0) return;
    e.preventDefault();
    addFiles(pasted);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  const issues = trpc.issues.all.useQuery(undefined, { staleTime: 60_000, enabled: false });
  const worklogs = trpc.worklogs.list.useQuery(
    { issueKey: thread.issue.key, connectionId: thread.issue.connectionId ?? undefined },
    { enabled: false, staleTime: 30_000 },
  );

  return (
    <form
      className={cn("relative shrink-0 border-t px-3 pb-3 pt-2 @m:px-4", dragging && "bg-primary-soft/40")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => {
        if (editing || ![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      data-chat-composer
    >
      {dragging && (
        <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary-strong text-body-sm font-medium text-primary-strong" aria-hidden>
          {t("pages.chat.composer.drop")}
        </p>
      )}
      {(replyTo || editing) && (
        <div className="mb-2 flex min-w-0 items-center gap-2 rounded-md bg-muted px-2 py-1 text-caption" {...surface("chip")}>
          {editing ? <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <CornerUpLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="shrink-0 font-medium">{editing ? t("pages.chat.composer.editing") : t("pages.chat.composer.replying", { name: nameIn(thread.members, replyTo!.authorId, self) })}</span>
          {!editing && <span className="truncate text-muted-foreground">{chatPreview(replyTo!.body, 100)}</span>}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={editing ? t("pages.chat.composer.cancelEdit") : t("pages.chat.composer.cancelReply")}
            title={editing ? t("pages.chat.composer.cancelEdit") : t("pages.chat.composer.cancelReply")}
            onClick={() => (editing ? onDoneEditing() : onCancelReply())}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {(refs.length > 0 || uploads.length > 0) && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={t("pages.chat.composer.attach")}>
          {refs.map((r, i) => (
            <li key={`r${i}`} {...surface("chip")} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-card pl-2 text-caption">
              {r.kind === "issue" ? <Hash className="h-3.5 w-3.5 shrink-0" aria-hidden /> : r.kind === "worklog" ? <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />}
              <span className="truncate">{r.kind === "issue" ? `${r.key} · ${r.title}` : r.kind === "worklog" ? `${r.key} · ${formatDuration(r.seconds)}` : r.excerpt}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("pages.chat.composer.removeCard")} title={t("pages.chat.composer.removeCard")} onClick={() => setRefs((list) => list.filter((_, j) => j !== i))}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.key} {...surface("chip")} className={cn("flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-card pl-2 text-caption", u.error && "border-danger/60")}>
              <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{u.name}</span>
              {u.error ? (
                <span role="alert" className="truncate text-danger">
                  {u.error}
                </span>
              ) : u.file ? (
                <span className="shrink-0 text-muted-foreground">{formatBytes(u.file.size)}</span>
              ) : (
                <span role="status" className="shrink-0 tabular-nums text-muted-foreground" aria-label={t("pages.chat.composer.uploading", { name: u.name })}>
                  {u.progress}%
                </span>
              )}
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("pages.chat.composer.removeFile", { name: u.name })} title={t("pages.chat.composer.removeFile", { name: u.name })} onClick={() => dropUpload(u)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {/* Narrow (the thread under 28rem): the box and Send on one row, the attach tools under them; wider, tools | box | Send. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-1.5 gap-y-1 @m:grid-cols-[auto_minmax(0,1fr)_auto]">
        <div className="col-span-2 row-start-2 flex shrink-0 items-center @m:col-span-1 @m:row-start-1">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }} />
          <Button type="button" variant="ghost" size="icon" className="coarse:size-touch" disabled={!!editing || uploads.length >= CHAT_FILES_PER_MESSAGE} aria-label={t("pages.chat.composer.attach")} title={t("pages.chat.composer.attach")} onClick={() => fileInput.current?.click()}>
            <Paperclip className="h-4 w-4" />
          </Button>
          <IssuePicker
            issues={issues.data ?? []}
            value={null}
            onOpenChange={(open) => open && void issues.refetch()}
            onChange={(pick) => {
              const found = (issues.data ?? []).find((i) => i.key === pick?.key && i.connectionId === pick?.connectionId);
              if (!pick || refs.length >= CHAT_REFS_MAX) return;
              setRefs((list) => [...list, { kind: "issue", key: pick.key, title: found?.summary ?? "", status: found?.status ?? "", category: found?.category ?? "" }]);
              input.current?.focus();
            }}
          >
            <Button type="button" variant="ghost" size="icon" className="coarse:size-touch" disabled={!!editing} aria-label={t("pages.chat.composer.attachIssue")} title={t("pages.chat.composer.attachIssue")}>
              <Hash className="h-4 w-4" />
            </Button>
          </IssuePicker>
          {thread.issue.connectionId !== null && (
            <Popover onOpenChange={(open) => open && void worklogs.refetch()}>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="coarse:size-touch" disabled={!!editing} aria-label={t("pages.chat.composer.attachWorklog")} title={t("pages.chat.composer.attachWorklog")}>
                  <Clock className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-1">
                {(worklogs.data ?? []).length === 0 ? (
                  <p className="p-2 text-caption text-muted-foreground">{worklogs.isFetching ? t("pages.chat.messages.loading") : t("pages.chat.composer.noWorklogs")}</p>
                ) : (
                  <ul className="grid max-h-72 grid-cols-[minmax(0,1fr)] overflow-y-auto">
                    {(worklogs.data ?? []).slice(0, 50).map((w) => (
                      <li key={w.id}>
                        <button
                          type="button"
                          className="grid min-h-target w-full gap-0.5 rounded-md px-2 py-1.5 text-left outline-clear hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch"
                          onClick={() => {
                            const started = new Date(w.started);
                            const date = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")}`;
                            if (refs.length < CHAT_REFS_MAX) setRefs((list) => [...list, { kind: "worklog", key: w.issueKey, date, seconds: w.timeSpentSeconds, comment: (w.comment ?? "").slice(0, 2000) }]);
                            input.current?.focus();
                          }}
                        >
                          <span className="flex items-baseline justify-between gap-2 text-body-sm">
                            <span>{dateFormat({ weekday: "short", day: "numeric", month: "short" }).format(new Date(w.started))}</span>
                            <span className="font-semibold tabular-nums">{formatDuration(w.timeSpentSeconds)}</span>
                          </span>
                          {w.comment && <span className="truncate text-caption text-muted-foreground">{w.comment}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>
        <Textarea
          ref={input}
          autoFocus={autoFocus}
          rows={1}
          value={text}
          maxLength={CHAT_BODY_MAX}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={t("pages.chat.composer.placeholder")}
          aria-label={t("pages.chat.composer.label")}
          aria-describedby={HINT_ID}
          className="max-h-40 min-h-touch resize-none overflow-y-auto @m:col-start-2 @m:row-start-1"
        />
        <Button type="submit" size="icon" className="coarse:size-touch @m:col-start-3 @m:row-start-1" disabled={!(canSend || (busy && ready && !editing)) || queued} aria-label={editing ? t("pages.chat.composer.save") : t("pages.chat.composer.send")} title={editing ? t("pages.chat.composer.save") : t("pages.chat.composer.send")}>
          <SendHorizontal className="h-4 w-4" />
        </Button>
      </div>
      {queued ? (
        <p role="status" className="mt-1 text-caption text-muted-foreground">
          {t("pages.chat.composer.queued")}
        </p>
      ) : (
        <p id={HINT_ID} className="mt-1 text-caption text-muted-foreground max-sm:hidden coarse:hidden">
          {t("pages.chat.composer.hint")}
        </p>
      )}
    </form>
  );
}

/** A file uploaded and not sent: its address to take it back. */
const chatDraftUrl = (id: number) => `/api/chat/files/${id}`;
