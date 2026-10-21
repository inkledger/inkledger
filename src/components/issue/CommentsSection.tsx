import { useState } from "react";
import { surface } from "@/components/app/surface";
import { Send } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { initials, relativeTime } from "@/lib/initials";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Chip } from "@/components/app/Chip";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PALETTE_SHORTCUT } from "@/lib/dom";
import { toast } from "sonner";
import { RichText } from "@/components/app/RichText";
import { useProviderName } from "@/hooks/useConnections";
import { t, dateFormat } from "@/i18n";

/** Jira comments of an issue with a composer (posts to Jira). */
export function CommentsSection({ issueKey, connectionId }: { issueKey: string; connectionId?: number | null }) {
  const provider = useProviderName(connectionId);
  const utils = trpc.useUtils();
  const comments = trpc.issues.comments.useQuery(
    { key: issueKey },
    { retry: false }
  );
  // Same query as the attachments section (cached): resolves !image.png! embeds.
  const attachments = trpc.issues.attachments.useQuery(
    { key: issueKey },
    { retry: false }
  );
  const images = new Map((attachments.data ?? []).map(a => [a.filename, a.id]));
  const [text, setText] = useState("");
  const [now] = useState(() => Date.now());
  const add = trpc.issues.addComment.useMutation({
    onSuccess: () => {
      setText("");
      toast.success(t("views.issue.comments.posted", { provider }));
      void utils.issues.comments.invalidate({ key: issueKey });
    },
    onError: e => toast.error(e.message),
  });
  const submit = () => {
    if (text.trim() && !add.isPending) add.mutate({ key: issueKey, text });
  };
  const modifier = PALETTE_SHORTCUT.startsWith("⌘") ? "⌘" : "Ctrl";

  return (
    <div className="grid gap-5">
      <form
        className="grid gap-2"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={`comment-${issueKey}`} className="sr-only">
          {t("views.issue.comments.new")}
        </label>
        <Textarea
          id={`comment-${issueKey}`}
          placeholder={t("views.issue.comments.placeholder")}
          rows={3}
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
            {t("views.issue.comments.hint", { modifier })}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={!text.trim() || add.isPending}
          >
            <Send className="h-4 w-4" />
            {add.isPending ? t("views.issue.comments.posting") : t("views.issue.comments.post")}
          </Button>
        </div>
      </form>

      {comments.isPending ? (
        <div className="grid gap-3">
          {[0, 1].map(n => (
            <Skeleton key={n} className="h-20" />
          ))}
        </div>
      ) : comments.error ? (
        <ErrorState
          message={comments.error.message}
          onRetry={() => comments.refetch()}
        />
      ) : comments.data.length === 0 ? (
        <EmptyState art="chat" title={t("views.issue.comments.empty")} className="py-6" />
      ) : (
        <ol className="grid gap-4">
          {comments.data.map(c => {
            const created = new Date(c.created);
            return (
              <li key={c.id} className="flex gap-3">
                <ProjectAvatar
                  project={c.author}
                  label={initials(c.author)}
                  icon={false}
                  className="h-9 w-9"
                />
                <div {...surface("card")} className="min-w-0 flex-1 rounded-xl border bg-background px-3.5 py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">{c.author}</span>
                    {c.isMine && <Chip>{t("views.issue.comments.you")}</Chip>}
                    <time
                      dateTime={c.created}
                      title={dateFormat({ dateStyle: "long", timeStyle: "short" }).format(created)}
                      className="text-caption text-muted-foreground"
                    >
                      {relativeTime(created, now)}
                      {c.edited && t("views.issue.comments.edited")}
                    </time>
                  </div>
                  <RichText doc={c.doc} images={images} connectionId={connectionId} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
