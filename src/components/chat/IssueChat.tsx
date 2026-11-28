import { useState } from "react";
import { MessageSquarePlus, MessagesSquare } from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { ChatRef } from "@contracts/chat";
import { surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/initials";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { AvatarStack } from "./People";
import { chatPath, nameIn, namesList } from "./chatText";
import { ChatThread } from "./ChatThread";
import { TeammatePicker } from "./TeammatePicker";

/**
 * "Chat about this issue": the picker, then the chat in Notifications (Back returns to the issue).
 * Icon only in an issue's header (its name in the tooltip and for assistive tech).
 */
export function ChatButton({ issueKey, connectionId, iconOnly = true }: { issueKey: string; connectionId: number; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Button variant="ghost" size={iconOnly ? "icon" : "sm"} aria-label={iconOnly ? t("pages.chat.open") : undefined} title={t("pages.chat.open")} onClick={() => setOpen(true)}>
        <MessagesSquare className="h-4 w-4" />
        {!iconOnly && t("pages.chat.openShort")}
      </Button>
      {open && (
        <TeammatePicker
          open
          onOpenChange={setOpen}
          connectionId={connectionId}
          issueKey={issueKey}
          onDone={(threadId) => {
            setOpen(false);
            void navigate(chatPath(threadId));
          }}
        />
      )}
    </>
  );
}

/** "Discuss in chat" on a tracker comment: a chat whose first message quotes it. */
export function DiscussButton({ issueKey, connectionId, comment }: { issueKey: string; connectionId: number; comment: { id: string; author: string; created: string; text: string } }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const card: ChatRef = { kind: "comment", key: issueKey, commentId: comment.id, author: comment.author.slice(0, 200), created: comment.created.slice(0, 40), excerpt: comment.text.slice(0, 2000) };
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label={t("pages.chat.discussTitle")} title={t("pages.chat.discuss")} onClick={() => setOpen(true)}>
        <MessageSquarePlus className="h-4 w-4" />
      </Button>
      {open && (
        <TeammatePicker
          open
          onOpenChange={setOpen}
          connectionId={connectionId}
          issueKey={issueKey}
          firstRefs={[card]}
          onDone={(threadId) => {
            setOpen(false);
            void navigate(chatPath(threadId));
          }}
        />
      )}
    </>
  );
}

/**
 * An issue's chats (the reader's): each with its people and latest line, one opened in place
 * (bounded, its own scroll), a new one with a teammate. Under the issue's comments.
 */
export function IssueChatSection({ issueKey, connectionId }: { issueKey: string; connectionId: number }) {
  const threads = trpc.chat.forIssue.useQuery({ key: issueKey, connectionId }, { retry: false });
  const self = useAuth().user?.id ?? null;
  const [open, setOpen] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [now] = useState(() => Date.now());
  const list = threads.data ?? [];
  const current = open ?? (list.length === 1 ? list[0].id : null);
  return (
    <div className="grid gap-3" data-issue-chat>
      {threads.isPending ? (
        <Skeleton className="h-12" aria-hidden />
      ) : list.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("pages.chat.sectionEmpty")}</p>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {list.map((th) => {
            const others = th.members.filter((m) => m.userId !== self && !m.left);
            const on = th.id === current;
            return (
              <li key={th.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setOpen(on ? -1 : th.id)}
                  {...surface("card", { on })}
                  className={cn(
                    "grid min-h-target w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border bg-card p-2 text-left outline-clear focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch",
                    on && "border-primary-strong/60 bg-primary-soft/40",
                  )}
                >
                  <AvatarStack names={others.map((m) => m.name)} max={2} size="sm" />
                  <span className="grid min-w-0">
                    <span className={cn("truncate text-body-sm", th.unread > 0 ? "font-semibold" : "font-medium")}>{namesList(others.map((m) => m.name), 2)}</span>
                    <span className="truncate text-caption text-muted-foreground">
                      {th.last && th.last.kind === "text" ? `${th.last.authorId === self ? `${t("pages.chat.you")}: ` : others.length > 1 ? `${nameIn(th.members, th.last.authorId, self)}: ` : ""}${th.last.preview || t("pages.chat.filesOnly", { count: th.last.files })}` : relativeTime(new Date(th.lastMessageAt), now)}
                    </span>
                  </span>
                  {th.unread > 0 && (
                    <span className="rounded-full bg-primary-soft px-1.5 text-2xs font-semibold text-primary-strong tabular-nums" {...surface("chip")}>
                      {th.unread}
                      <span className="sr-only"> {t("pages.chat.unread", { count: th.unread })}</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {current !== null && current > 0 && <ChatThread key={current} threadId={current} variant="inline" onGone={() => setOpen(-1)} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
          <MessageSquarePlus className="h-4 w-4" />
          {list.length === 0 ? t("pages.chat.ask") : t("pages.chat.newChat")}
        </Button>
        {current !== null && current > 0 && (
          <Button variant="ghost" size="sm" asChild>
            <Link to={chatPath(current)}>{t("pages.chat.openInInbox")}</Link>
          </Button>
        )}
      </div>
      {picking && (
        <TeammatePicker
          open
          onOpenChange={setPicking}
          connectionId={connectionId}
          issueKey={issueKey}
          onDone={(threadId) => {
            setPicking(false);
            setOpen(threadId);
            void threads.refetch();
          }}
        />
      )}
    </div>
  );
}
