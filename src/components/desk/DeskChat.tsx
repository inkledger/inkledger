import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ChevronRight, CircleStop, FileText, FolderOpen, FolderPlus, FolderSearch, GitCommitHorizontal, History, MessageSquarePlus, NotebookPen, Search, SendHorizontal, ShieldCheck, Sparkles, X } from "lucide-react";
import { deskIssues, paneId, type DeskSlot } from "@contracts/desk";
import { NOTE_BODY_MAX, NOTE_TITLE_MAX } from "@contracts/notes";
import { trpc } from "@/lib/trpc";
import { ask, chatMarkdown, clearChat, stop, useDeskChat, type ChatMessage } from "@/lib/desk/chat";
import { describeCall, useCodeReach, type CodeReach } from "@/lib/desk/code";
import type { AgentStep } from "@/lib/desk/agent";
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

  const code = useCodeReach(panes);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const send = (text: string) => {
    if (!text.trim() || streaming || !shown.length) return;
    setDraft("");
    const issues = code.issues.length ? code.issues : shown.map(p => ({ key: p.key, title: titleOf(p.key, p.connectionId) ?? "" }));
    void ask(text, panes, { mode: code.mode, tools: code.tools, repos: code.repos, issues });
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
          {shown.length > 0 && <CodeRow code={code} />}

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

/**
 * The code in reach (batch 4d): its repositories as chips, what each still needs (allow it
 * in the app, connect a folder in a browser), and the mode in plain words.
 */
function CodeRow({ code }: { code: CodeReach }) {
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<void>) => {
    setBusy(true);
    void work()
      .catch((e: unknown) => toastError(e))
      .finally(() => setBusy(false));
  };
  if (code.loading) return null;
  const ready = code.views.filter(v => v.state === "ready");
  const pending = code.views.filter(v => v.state !== "ready");
  const hasGit = code.repos.some(r => r.git);
  const line =
    code.mode === "tools"
      ? t(hasGit ? "pages.deskChat.code.modeTools" : "pages.deskChat.code.modeToolsNoGit")
      : code.mode === "extracts"
        ? t("pages.deskChat.code.modeExtracts")
        : code.where === "none"
          ? t("pages.deskChat.code.elsewhere")
          : !code.projects.length
            ? t("pages.deskChat.code.noProject")
            : code.where === "native" && !code.views.length
              ? t("pages.deskChat.code.noRepos")
              : code.where === "native"
                ? t("pages.deskChat.code.allowHint")
                : t("pages.deskChat.code.connectHint");
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2" data-chat-code={code.mode}>
      <h3 className="mr-1 text-overline uppercase text-muted-foreground">{t("pages.deskChat.code.heading")}</h3>
      {ready.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1" aria-label={t("pages.deskChat.code.repos")} data-chat-repos>
          {ready.map(v => (
            <li key={v.kind === "native" ? v.root : v.folder.id} title={v.kind === "native" ? v.root : undefined} className="flex items-center">
              <Chip>{v.label}</Chip>
              {v.kind === "browser" && (
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground coarse:size-touch" aria-label={t("pages.deskChat.code.disconnect", { label: v.label })} onClick={() => act(() => code.disconnect(v.folder.id))}>
                  <X className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending.map(v => (
        <Button
          key={v.kind === "native" ? v.root : v.folder.id}
          variant="outline"
          size="sm"
          className="min-h-touch sm:min-h-0"
          disabled={busy}
          title={v.kind === "native" ? t("pages.deskChat.code.allowTitle", { path: v.root }) : undefined}
          onClick={() => act(() => (v.kind === "native" ? code.allow(v.root) : code.permit(v.folder)))}
        >
          <ShieldCheck aria-hidden />
          {v.kind === "native" ? t("pages.deskChat.code.allow", { label: v.label }) : t("pages.deskChat.code.permit", { label: v.label })}
        </Button>
      ))}
      {code.where === "browser" &&
        // A project whose folder is connected needs no other button (disconnect it to pick another).
        code.projects
          .filter(p => !code.views.some(v => v.kind === "browser" && v.folder.containerId === p.containerId))
          .map(p => (
          <Button
            key={p.containerId}
            variant="outline"
            size="sm"
            className="min-h-touch sm:min-h-0"
            disabled={busy}
            title={t("pages.deskChat.code.connectTitle", { name: p.name || p.key })}
            onClick={() => act(() => code.connect(p.containerId))}
          >
            <FolderPlus aria-hidden />
            {code.projects.length > 1 ? t("pages.deskChat.code.connectFor", { key: p.key }) : t("pages.deskChat.code.connect")}
          </Button>
        ))}
      <p className={cn("text-caption text-muted-foreground", code.views.length || (code.where === "browser" && code.projects.length) ? "basis-full" : "min-w-0 flex-1")} data-chat-mode>
        {line}
      </p>
    </div>
  );
}

const STEP_ICON: Record<AgentStep["call"]["name"], typeof Search> = { ls: FolderOpen, find: FolderSearch, grep: Search, read: FileText, git_log: History, git_show: GitCommitHorizontal };

/** The tool steps of an answer: one compact line each, opened to show what the model read. */
function Steps({ steps }: { steps: AgentStep[] }) {
  return (
    <ol className="mb-2 flex flex-col gap-0.5" aria-label={t("pages.deskChat.steps")} data-chat-steps>
      {steps.map(s => {
        const Icon = STEP_ICON[s.call.name];
        return (
          <li key={s.id} data-chat-step={s.status}>
            <details className="group">
              <summary className="flex min-h-target cursor-pointer list-none items-center gap-1.5 rounded-sm text-caption text-muted-foreground coarse:min-h-touch hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 group-open:rotate-90" aria-hidden />
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{s.status === "running" ? `${describeCall(s.call)}…` : s.brief}</span>
                {s.status === "failed" && <span className="sr-only">({t("pages.deskChat.stepFailed")})</span>}
              </summary>
              {s.text && (
                <div
                  {...surface("card")}
                  // Scrolls when long: reachable by keyboard.
                  tabIndex={0}
                  className="mb-1 ml-5 mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 px-2 py-1 text-caption [overflow-wrap:anywhere]"
                  data-chat-step-text
                >
                  {s.text}
                </div>
              )}
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/** An answer; the last one also offers to save the whole conversation as a note. */
function Answer({ message, save }: { message: ChatMessage; save: { run: () => void; busy: boolean } | null }) {
  const { text, doc, status, steps, mode } = message;
  const working = status === "streaming" && steps.some(s => s.status === "running");
  return (
    <article className="min-w-0" data-chat-answer={status} aria-busy={status === "streaming"}>
      {steps.length > 0 && <Steps steps={steps} />}
      {status === "error" ? (
        <p role="alert" className="text-body-sm text-danger">
          {text}
        </p>
      ) : doc && doc.blocks.length > 0 ? (
        <RichText doc={doc} images={new Map()} variant="document" headingLevel={3} />
      ) : working && !text ? null : (
        <p className={cn("whitespace-pre-wrap text-body-sm [overflow-wrap:anywhere]", !text && "text-muted-foreground")}>
          {text || (steps.length ? t("pages.deskChat.writing") : t("pages.deskChat.reading"))}
        </p>
      )}
      {status === "stopped" && <p className="mt-1 text-caption text-muted-foreground">{t("pages.deskChat.stopped")}</p>}
      {/* A model may claim it checked without calling a tool (seen with small models): said plainly. */}
      {status === "done" && mode === "tools" && steps.length === 0 && (
        <p className="mt-1 text-caption text-muted-foreground" data-chat-no-steps>
          {t("pages.deskChat.noSteps")}
        </p>
      )}
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
