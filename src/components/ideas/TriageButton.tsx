import { Link } from "react-router";
import { Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/app/Chip";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/** On an issue's page (docs/work/ideas/triage.md R-2.4, R-2.10): "In triage" when an idea is open for it, else "Send to triage" (nothing written to the tracker). */
export function TriageButton({ issueKey, connectionId }: { issueKey: string; connectionId: number }) {
  const utils = trpc.useUtils();
  const open = trpc.ideas.forIssue.useQuery({ issueKey, connectionId }, { staleTime: 60_000, retry: false });
  const send = trpc.ideas.fromIssue.useMutation({
    onSuccess: idea => utils.ideas.forIssue.setData({ issueKey, connectionId }, { id: idea.id, state: idea.state }),
    onError: e => toastError(e),
    onSettled: () => void utils.ideas.list.invalidate(),
  });
  if (open.isLoading || open.isError) return null;
  if (open.data)
    return (
      <Link to={`/ideas?open=${open.data.id}`} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Chip tone="info">{t("ui.ideas.inTriage")}</Chip>
      </Link>
    );
  return (
    <Button variant="ghost" size="sm" disabled={send.isPending} onClick={() => send.mutate({ issueKey, connectionId })}>
      <Lightbulb className="h-4 w-4" aria-hidden />
      {t("ui.ideas.sendToTriage")}
    </Button>
  );
}
