import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { surface } from "@/components/app/surface";
import { trpc } from "@/lib/trpc";
import { issuePath } from "@/lib/issues";
import { useConnections } from "@/hooks/useConnections";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/app/PageHeader";
import { t } from "@/i18n";
import IssueDetail from "./IssueDetail";
import NotFound from "./NotFound";

function Loading() {
  return (
    <div className="grid gap-3 p-3 md:p-5">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

/** /issues/:connectionId/:remoteId: the issue by its identity, whatever its key is now. */
export function IssueByRef() {
  const { connectionId = "", remoteId = "" } = useParams();
  const conn = Number(connectionId);
  const found = trpc.issues.locate.useQuery({ connectionId: conn, remoteId }, { enabled: conn > 0 && remoteId !== "" });
  if (found.isPending) return <Loading />;
  if (!found.data || "ambiguous" in found.data) return <NotFound />;
  return <IssueDetail issueKey={found.data.key} connectionId={found.data.connectionId} />;
}

/** The same key on more than one connection: which one. */
function WhichIssue({ issueKey, candidates }: { issueKey: string; candidates: { connectionId: number; remoteId: string; key: string; summary: string }[] }) {
  const connections = useConnections().data ?? [];
  const where = (id: number) => {
    const c = connections.find(x => x.id === id);
    return c ? `${c.label || c.name} · ${c.host}` : "";
  };
  return (
    <>
      <PageHeader title={issueKey} description={t("pages.issueDetail.whichOne")} />
      <ul className="grid gap-2 p-3 md:p-5">
        {candidates.map(c => (
          <li key={c.connectionId}>
            <Link
              to={issuePath({ key: c.key, connectionId: c.connectionId, remoteId: c.remoteId })}
              {...surface("card")}
              className="block rounded-lg border bg-card p-3 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span className="block truncate text-body-sm font-medium">{c.summary}</span>
              <span className="block truncate text-caption text-muted-foreground">{where(c.connectionId)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * /issues/:key, from older links and typed keys: to the issue's own link
 * when the catalogue has it (an old key too), a choice when two connections
 * have that key, else shown live by its key. ?c= names the connection when
 * the link knows it (a timer, a notification): never a choice then.
 */
export function IssueByKey() {
  const { key = "" } = useParams();
  const [params] = useSearchParams();
  const connectionId = Number(params.get("c")) || undefined;
  const found = trpc.issues.locate.useQuery({ key, ...(connectionId ? { connectionId } : {}) });
  if (found.isPending) return <Loading />;
  if (found.data && "ambiguous" in found.data) return <WhichIssue issueKey={key} candidates={found.data.candidates} />;
  if (found.data) return <Navigate to={issuePath({ key: found.data.key, connectionId: found.data.connectionId, remoteId: found.data.remoteId })} replace />;
  return <IssueDetail issueKey={key} connectionId={connectionId} />;
}
