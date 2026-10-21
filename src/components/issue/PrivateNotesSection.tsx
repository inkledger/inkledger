import { useState } from "react";
import { surface } from "@/components/app/surface";
import { useNavigate } from "react-router";
import { Lock, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/initials";
import { PALETTE_SHORTCUT } from "@/lib/dom";
import { pinboardBoard, pinboardPanel } from "@/hooks/usePinboardPanel";
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
export function PrivateNotesSection({ issueKey, connectionId }: { issueKey: string; connectionId?: number | null }) {
  const provider = useProviderName(connectionId);
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const conn = connectionId ?? undefined;
  const notes = trpc.issueNotes.list.useQuery({ issueKey, connectionId: conn });
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [now] = useState(() => Date.now());
  const modifier = PALETTE_SHORTCUT.startsWith("⌘") ? "⌘" : "Ctrl";
  const refresh = () =>
    Promise.all([
      utils.issueNotes.list.invalidate({ issueKey, connectionId: conn }),
      utils.pinboard.list.invalidate(),
      utils.pinboard.boards.invalidate(),
    ]);
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

  const add = trpc.issueNotes.add.useMutation({
    onSuccess: () => {
      setText("");
      void refresh();
    },
    onError: fail,
  });
  const submit = () => {
    if (text.trim() && !add.isPending) add.mutate({ issueKey, connectionId: conn, body: text });
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
              .mutate({ issueKey: gone.issueKey, connectionId: gone.connectionId, body: gone.body, createdAt: new Date(gone.createdAt).getTime() })
              .then(refresh, fail),
        },
      });
    } catch (e) {
      fail(e);
    }
  };
  const hang = async (id: number) => {
    try {
      const r = await utils.client.pinboard.pinNote.mutate({ noteId: id, boardId: pinboardBoard.get() ?? undefined });
      await refresh();
      toast.success(
        r.existed
          ? t("views.issue.privateNotes.hungAgain", { board: r.boardName })
          : t("views.issue.privateNotes.hung", { board: r.boardName, key: issueKey }),
        {
          action: {
            label: t("views.issue.privateNotes.open"),
            onClick: () => {
              pinboardPanel.set("open");
              void navigate("/board");
            },
          },
        }
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
          <Button type="submit" size="sm" variant="outline" disabled={!text.trim() || add.isPending}>
            <Plus className="h-4 w-4" />
            {t("views.issue.privateNotes.add")}
          </Button>
        </div>
      </form>

      {notes.isPending ? (
        <Skeleton className="h-16" />
      ) : notes.error ? (
        <ErrorState message={notes.error.message} onRetry={() => notes.refetch()} />
      ) : notes.data.length === 0 ? (
        <EmptyState art="chat" title={t("views.issue.privateNotes.empty")} className="py-4" />
      ) : (
        <ol className="grid gap-3">
          {notes.data.map(n => {
            const created = new Date(n.createdAt);
            const edited = new Date(n.updatedAt).getTime() - created.getTime() > 60_000;
            const isEditing = editing?.id === n.id;
            return (
              <li key={n.id} {...surface("card")} className="note-paper grain rounded-lg px-3.5 py-2.5" data-private-note={n.id}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <time
                    dateTime={created.toISOString()}
                    title={dateFormat({ dateStyle: "long", timeStyle: "short" }).format(created)}
                    className="text-caption text-muted-foreground"
                  >
                    {relativeTime(created, now)}
                    {edited && t("views.issue.privateNotes.edited")}
                  </time>
                  {n.pinnedOn.map(b => (
                    <span key={b.boardId} className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                      <Pin className="h-3 w-3" aria-hidden />
                      {t("views.issue.privateNotes.hungOn", { board: b.boardName })}
                    </span>
                  ))}
                  {!isEditing && (
                    <span className="ml-auto flex items-center gap-0.5">
                      <Button size="sm" variant="ghost" aria-label={t("views.issue.privateNotes.hangLabel")} title={t("views.issue.privateNotes.hang")} onClick={() => void hang(n.id)}>
                        <Pin className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">{t("views.issue.privateNotes.hang")}</span>
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("views.issue.privateNotes.editLabel")} title={t("views.issue.privateNotes.edit")} onClick={() => setEditing({ id: n.id, body: n.body })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("views.issue.privateNotes.deleteLabel")} title={t("views.issue.privateNotes.delete")} onClick={() => void remove(n.id)}>
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
                      onChange={e => setEditing({ id: n.id, body: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === "Escape") setEditing(null);
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void save();
                        }
                      }}
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {t("views.issue.privateNotes.cancel")}
                      </Button>
                      <Button size="sm" disabled={!editing.body.trim()} onClick={() => void save()}>
                        {t("views.issue.privateNotes.save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 whitespace-pre-line break-words text-body">{n.body}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
