import { MakeTodoButton } from "@/components/todo/MakeTodo";
import { firstLine } from "@/lib/todoDay";
import { toastError, errorText } from "@/lib/errorText";
import { useState } from "react";
import { surface } from "@/components/app/surface";
import { Lock, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/initials";
import { PALETTE_SHORTCUT } from "@/lib/dom";
import {
  canShowPinboard,
  pinboardBoard,
  showPinboard,
} from "@/hooks/usePinboardPanel";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useProviderName } from "@/hooks/useConnections";
import { t, dateFormat } from "@/i18n";

/**
 * The user's own notes on an issue: written here, kept in inkledger, never sent to
 * Jira. Any of them can hang on the pinboard, tied to the issue's post-it by
 * a red string.
 */
export function PrivateNotesSection({
  issueKey,
  connectionId,
}: {
  issueKey: string;
  connectionId?: number | null;
}) {
  const provider = useProviderName(connectionId);
  const utils = trpc.useUtils();
  const conn = connectionId ?? undefined;
  const notes = trpc.issueNotes.list.useQuery({ issueKey, connectionId: conn });
  // TODOs already made from each note (open ones).
  const todos = trpc.todos.forIssue.useQuery(
    { issueKey, connectionId: conn },
    { retry: false }
  );
  const todosOf = (id: number) =>
    (todos.data ?? []).filter(x => x.issueNoteId === id).length;
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(
    null
  );
  const [now] = useState(() => Date.now());
  const modifier = PALETTE_SHORTCUT.startsWith("⌘") ? "⌘" : "Ctrl";
  const refresh = () =>
    Promise.all([
      utils.issueNotes.list.invalidate({ issueKey, connectionId: conn }),
      utils.pinboard.list.invalidate(),
      utils.pinboard.boards.invalidate(),
      // Hanging a note pins its issue too: the pin button says so.
      utils.pinboard.where.invalidate(),
    ]);
  const fail = (e: unknown) => toastError(e);

  const add = trpc.issueNotes.add.useMutation({
    onSuccess: () => {
      setText("");
      void refresh();
    },
    onError: fail,
  });
  const submit = () => {
    if (text.trim() && !add.isPending)
      add.mutate({ issueKey, connectionId: conn, body: text });
  };
  const save = async () => {
    if (!editing?.body.trim()) return;
    try {
      await utils.client.issueNotes.update.mutate(editing);
      setEditing(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (id: number) => {
    try {
      const gone = await utils.client.issueNotes.remove.mutate({ id });
      await refresh();
      toast.success(t("views.issue.privateNotes.deleted"), {
        action: {
          label: t("views.issue.privateNotes.undo"),
          onClick: () =>
            void utils.client.issueNotes.restore
              .mutate({
                issueKey: gone.issueKey,
                connectionId: gone.connectionId,
                body: gone.body,
                createdAt: new Date(gone.createdAt).getTime(),
              })
              .then(refresh, fail),
        },
      });
    } catch (e) {
      fail(e);
    }
  };
  const hang = async (id: number) => {
    try {
      const r = await utils.client.pinboard.pinNote.mutate({
        noteId: id,
        boardId: pinboardBoard.get() ?? undefined,
      });
      await refresh();
      toast.success(
        r.existed
          ? t("views.issue.privateNotes.hungAgain", { board: r.boardName })
          : t("views.issue.privateNotes.hung", {
              board: r.boardName,
              key: issueKey,
            }),
        canShowPinboard()
          ? {
              action: {
                label: t("views.issue.privateNotes.open"),
                onClick: () => {
                  pinboardBoard.set(r.boardId);
                  showPinboard();
                },
              },
            }
          : undefined
      );
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="grid gap-5" data-private-notes>
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Lock className="h-3.5 w-3.5" aria-hidden />
        {t("views.issue.privateNotes.private", { provider })}
      </p>
      <form
        className="grid gap-2"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={`private-note-${issueKey}`} className="sr-only">
          {t("views.issue.privateNotes.new")}
        </label>
        <Textarea
          id={`private-note-${issueKey}`}
          placeholder={t("views.issue.privateNotes.placeholder")}
          rows={2}
          maxLength={5000}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-muted-foreground">
            {t("views.issue.privateNotes.hint", { modifier })}
          </span>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!text.trim() || add.isPending}
          >
            <Plus className="h-4 w-4" />
            {t("views.issue.privateNotes.add")}
          </Button>
        </div>
      </form>

      {notes.isPending ? (
        <Skeleton className="h-16" />
      ) : notes.error ? (
        <ErrorState
          message={errorText(notes.error)}
          onRetry={() => notes.refetch()}
        />
      ) : notes.data.length === 0 ? (
        <EmptyState
          art="chat"
          title={t("views.issue.privateNotes.empty")}
          className="py-4"
        />
      ) : (
        <ol className="grid gap-3">
          {notes.data.map(n => {
            const created = new Date(n.createdAt);
            const edited =
              new Date(n.updatedAt).getTime() - created.getTime() > 60_000;
            const isEditing = editing?.id === n.id;
            return (
              // Its anchor: a TODO made from it links back here (#note-…).
              <li
                key={n.id}
                id={`note-${n.id}`}
                {...surface("card")}
                className="note-paper grain scroll-mt-24 rounded-lg px-3.5 py-2.5 data-[flash]:ring-2 data-[flash]:ring-primary-strong/40"
                data-private-note={n.id}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <time
                    dateTime={created.toISOString()}
                    title={dateFormat({
                      dateStyle: "long",
                      timeStyle: "short",
                    }).format(created)}
                    className="text-caption text-muted-foreground"
                  >
                    {relativeTime(created, now)}
                    {edited && t("views.issue.privateNotes.edited")}
                  </time>
                  {n.pinnedOn.map(b => (
                    <span
                      key={b.boardId}
                      className="inline-flex items-center gap-1 text-caption text-muted-foreground"
                    >
                      <Pin className="h-3 w-3" aria-hidden />
                      {t("views.issue.privateNotes.hungOn", {
                        board: b.boardName,
                      })}
                    </span>
                  ))}
                  {!isEditing && (
                    <span className="ml-auto flex items-center gap-0.5">
                      <MakeTodoButton
                        label={t("views.todos.fromNoteLabel")}
                        count={todosOf(n.id)}
                        initial={firstLine(n.body)}
                        link={{
                          issueKey,
                          connectionId: conn,
                          issueNoteId: n.id,
                        }}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("views.issue.privateNotes.hangLabel")}
                        title={t("views.issue.privateNotes.hang")}
                        onClick={() => void hang(n.id)}
                      >
                        <Pin className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">
                          {t("views.issue.privateNotes.hang")}
                        </span>
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label={t("views.issue.privateNotes.editLabel")}
                        title={t("views.issue.privateNotes.edit")}
                        onClick={() => setEditing({ id: n.id, body: n.body })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label={t("views.issue.privateNotes.deleteLabel")}
                        title={t("views.issue.privateNotes.delete")}
                        onClick={() => void remove(n.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  )}
                </div>
                {isEditing ? (
                  <div className="mt-2 grid gap-2">
                    <Textarea
                      autoFocus
                      rows={3}
                      maxLength={5000}
                      aria-label={t("views.issue.privateNotes.editLabel")}
                      value={editing.body}
                      onChange={e =>
                        setEditing({ id: n.id, body: e.target.value })
                      }
                      onKeyDown={e => {
                        if (e.key === "Escape") setEditing(null);
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void save();
                        }
                      }}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        {t("views.issue.privateNotes.cancel")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={!editing.body.trim()}
                        onClick={() => void save()}
                      >
                        {t("views.issue.privateNotes.save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 whitespace-pre-line [overflow-wrap:anywhere] text-body">
                    {n.body}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
