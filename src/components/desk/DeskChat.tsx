import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { CircleStop, MessageSquarePlus, NotebookPen, SendHorizontal, Sparkles, X } from "lucide-react";
import { deskIssues, paneId, type DeskSlot } from "@contracts/desk";
import { NOTE_BODY_MAX, NOTE_TITLE_MAX } from "@contracts/notes";
import { trpc } from "@/lib/trpc";
import { ask, chatMarkdown, clearChat, stop, useDeskChat, type ChatMessage } from "@/lib/desk/chat";
import { toastError } from "@/lib/errorText";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Chip } from "@/components/app/Chip";
import { CopyButton } from "@/components/app/CopyButton";
import { EmptyState, PageSpinner } from "@/components/app/States";
import { RichText } from "@/components/app/RichText";
import { surface } from "@/components/app/surface";
import { t } from "@/i18n";

const SUGGESTIONS = ["compare", "first", "common"] as const;
/** The composer's hint (one composer on the page). */
const HINT_ID = "desk-chat-hint";

type Props = {
  /** The desk's slots: the issues among them are the model's context (the parked ones never are). */
  panes: readonly DeskSlot[];
  /** The focused pane's issue: the one a saved note is linked to. */
  focused: { connectionId: number; key: string } | null;
  /** Beside the desk (wide screens), or a sheet over it (phones). */
  docked: boolean;
  onClose: () => void;
};

/**
 * "Ask AI" on the Desk (docs/work/desk.md, batch 4c): a conversation with the local model
 * about the issues shown. Beside the desk on wide screens, which stays usable; a full
 * sheet on phones. The conversation is the page's (src/lib/desk/chat.ts), kept while closed.
 */
export function DeskChat(props: Props) {
  const titleId = useId();
  if (props.docked)
    return (
      <aside
        aria-labelledby={titleId}
        data-desk-chat
        {...surface("card")}
        className="flex w-96 shrink-0 flex-col border-l bg-card xl:w-[28rem]"
        onKeyDown={e => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onClose();
        }}
      >
        <ChatBody {...props} heading={text => <h2 id={titleId} className="truncate font-display text-body font-semibold">{text}</h2>} />
      </aside>
    );
  return (
    <Sheet open onOpenChange={open => !open && props.onClose()}>
      <SheetContent side="right" hideClose data-desk-chat className="w-full gap-0 p-0 sm:max-w-md">
        <SheetDescription className="sr-only">{t("pages.deskChat.description")}</SheetDescription>
        <ChatBody {...props} heading={text => <SheetTitle className="truncate font-display text-body font-semibold">{text}</SheetTitle>} />
      </SheetContent>
    </Sheet>
  );
}

function ChatBody({ panes, focused, onClose, heading }: Props & { heading: (text: string) => ReactNode }) {
  const chat = useDeskChat();
  const llm = trpc.notes.llm.useQuery(undefined, { staleTime: 60_000 });
  const shown = deskIssues({ panes });
  const shownIds = shown.map(paneId);
  const read = chat.context?.map(paneId) ?? null;
  // The desk changed under the conversation: wholly (it starts over) or in part (said).
  const changedAll = read !== null && !shownIds.some(id => read.includes(id));
  const changed = read !== null && !changedAll && (read.length !== shownIds.length || shownIds.some(id => !read.includes(id)));
  useEffect(() => {
    if (changedAll && !chat.messages.some(m => m.status === "streaming")) clearChat();
  }, [changedAll, chat.messages]);
  const streaming = chat.messages.some(m => m.status === "streaming");
  const off = chat.off || llm.data?.available === false;
  const known = trpc.issues.all.useQuery(undefined, { enabled: false }).data;
  const titleOf = (key: string, connectionId: number) => known?.find(i => i.connectionId === connectionId && i.key === key)?.summary;

  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const send = (text: string) => {
    if (!text.trim() || streaming || !shown.length) return;
    setDraft("");
    void ask(text, panes);
  };

  // The finished answer (or what went wrong), said once: never each piece as it comes.
  const last = chat.messages.at(-1);
  const said = last?.role === "assistant" && last.status !== "streaming" ? (last.status === "stopped" ? `${t("pages.deskChat.stopped")} ${last.text}` : last.text) : "";

  const navigate = useNavigate();
  const create = trpc.notes.create.useMutation();
  const saveNote = () => {
    const issues = chat.context ?? shown.map(p => ({ connectionId: p.connectionId, key: p.key, title: titleOf(p.key, p.connectionId) ?? "" }));
    const link = (focused && issues.find(i => i.connectionId === focused.connectionId && i.key === focused.key)) || issues[0];
    if (!link) return;
    create.mutate(
      {
        title: t("pages.deskChat.noteTitle", { keys: issues.map(i => i.key).join(", ") }).slice(0, NOTE_TITLE_MAX),
        body: chatMarkdown(chat.messages, issues).slice(0, NOTE_BODY_MAX),
        issue: { connectionId: link.connectionId, issueKey: link.key },
      },
      {
        onSuccess: note =>
          toast.success(t("pages.deskChat.saved", { key: link.key }), { action: { label: t("pages.deskChat.openNote"), onClick: () => void navigate(`/notes/${note.id}`) } }),
        onError: e => toastError(e, { action: { label: t("common.retry"), onClick: saveNote } }),
      },
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-touch shrink-0 items-center gap-1 border-b py-1.5 pl-4 pr-2">
        <Sparkles className="h-4 w-4 shrink-0 text-primary-strong" aria-hidden />
        <div className="min-w-0 flex-1">{heading(t("pages.deskChat.title"))}</div>
        {!off && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearChat();
              input.current?.focus();
            }}
            disabled={!chat.messages.length}
          >
            <MessageSquarePlus aria-hidden />
            {t("pages.deskChat.newChat")}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("pages.deskChat.close")}>
          <X aria-hidden />
        </Button>
      </div>

      {llm.isPending ? (
        <PageSpinner />
      ) : off ? (
        <EmptyState icon={Sparkles} title={t("pages.deskChat.offTitle")} message={t("pages.deskChat.offMessage")} className="my-auto" />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2">
            <h3 className="mr-1 text-overline uppercase text-muted-foreground">{t("pages.deskChat.inContext")}</h3>
            {shown.length ? (
              <ul className="flex min-w-0 flex-wrap gap-1" aria-label={t("pages.deskChat.inContext")} data-chat-context>
                {shown.map(p => (
                  <li key={paneId(p)} title={titleOf(p.key, p.connectionId)}>
                    <Chip>{p.key}</Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-muted-foreground">{t("pages.deskChat.noIssues")}</p>
            )}
            {changed && (
              <p role="status" className="basis-full text-caption text-muted-foreground">
                {t("pages.deskChat.contextChanged", { keys: shown.map(p => p.key).join(", ") })}
              </p>
            )}
          </div>

          <Messages messages={chat.messages} onSuggest={send} canAsk={shown.length > 0} save={{ run: saveNote, busy: create.isPending }} />
          <p role="status" aria-live="polite" className="sr-only" data-chat-said>
            {said}
          </p>

          <form
            className="shrink-0 border-t px-4 pb-3 pt-2"
            onSubmit={e => {
              e.preventDefault();
              send(draft);
            }}
          >
            <div className="flex items-end gap-2">
              <Textarea
                ref={input}
                autoFocus
                rows={2}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  send(draft);
                }}
                placeholder={t("pages.deskChat.placeholder")}
                aria-label={t("pages.deskChat.inputLabel")}
                aria-describedby={HINT_ID}
                className="max-h-40 min-h-touch flex-1 resize-none"
              />
              {streaming ? (
                <Button type="button" variant="outline" onClick={stop} className="min-h-touch">
                  <CircleStop aria-hidden />
                  {t("pages.deskChat.stop")}
                </Button>
              ) : (
                <Button type="submit" size="icon" disabled={!draft.trim() || !shown.length} aria-label={t("pages.deskChat.send")} className="coarse:size-touch">
                  <SendHorizontal aria-hidden />
                </Button>
              )}
            </div>
            <p id={HINT_ID} className="mt-1 text-caption text-muted-foreground max-sm:hidden">
              {t("pages.deskChat.hint")}
            </p>
          </form>
        </>
      )}
    </div>
  );
}

function Messages({ messages, onSuggest, canAsk, save }: { messages: ChatMessage[]; onSuggest: (text: string) => void; canAsk: boolean; save: { run: () => void; busy: boolean } }) {
  const box = useRef<HTMLDivElement>(null);
  // Follows the answer as it grows while the reader is at the bottom; scrolled up, it stays put.
  const atBottom = useRef(true);
  const length = messages.reduce((n, m) => n + m.text.length, 0);
  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [length, messages.length]);
  if (!messages.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <EmptyState
          icon={Sparkles}
          title={t("pages.deskChat.emptyTitle")}
          message={t("pages.deskChat.emptyMessage")}
          className="my-auto"
          action={
            <ul className="mt-2 flex flex-col items-stretch gap-2" aria-label={t("pages.deskChat.suggestions")}>
              {SUGGESTIONS.map(s => (
                <li key={s}>
                  <Button variant="outline" className="min-h-touch w-full justify-start whitespace-normal text-left" disabled={!canAsk} onClick={() => onSuggest(t(`pages.deskChat.suggest.${s}`))}>
                    {t(`pages.deskChat.suggest.${s}`)}
                  </Button>
                </li>
              ))}
            </ul>
          }
        />
      </div>
    );
  return (
    <div
      ref={box}
      onScroll={e => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      aria-label={t("pages.deskChat.conversation")}
      role="region"
      tabIndex={0}
    >
      {messages.map((m, i) =>
        m.role === "user" ? <Question key={m.id} text={m.text} /> : <Answer key={m.id} message={m} save={i === messages.length - 1 ? save : null} />
      )}
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p {...surface("card")} className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-body-sm [overflow-wrap:anywhere]">
        <span className="sr-only">{t("pages.deskChat.you")}: </span>
        {text}
      </p>
    </div>
  );
}

/** An answer; the last one also offers to save the whole conversation as a note. */
function Answer({ message, save }: { message: ChatMessage; save: { run: () => void; busy: boolean } | null }) {
  const { text, doc, status } = message;
  return (
    <article className="min-w-0" data-chat-answer={status} aria-busy={status === "streaming"}>
      {status === "error" ? (
        <p role="alert" className="text-body-sm text-danger">
          {text}
        </p>
      ) : doc && doc.blocks.length > 0 ? (
        <RichText doc={doc} images={new Map()} variant="document" headingLevel={3} />
      ) : (
        <p className={cn("whitespace-pre-wrap text-body-sm [overflow-wrap:anywhere]", !text && "text-muted-foreground")}>{text || t("pages.deskChat.reading")}</p>
      )}
      {status === "stopped" && <p className="mt-1 text-caption text-muted-foreground">{t("pages.deskChat.stopped")}</p>}
      {(status === "done" || status === "stopped") && text.trim() && (
        <div className="mt-2 flex flex-wrap gap-2">
          <CopyButton text={text} label={t("pages.deskChat.copyAnswer")} />
          {save && (
            <Button variant="outline" size="sm" onClick={save.run} disabled={save.busy} title={t("pages.deskChat.saveNoteTitle")}>
              <NotebookPen aria-hidden />
              {t("pages.deskChat.saveNote")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
