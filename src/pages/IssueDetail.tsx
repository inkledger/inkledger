import { IssueBody } from "@/components/issue/IssueBody";

/** An issue's own page (the parts are in components/issue, shared with a desk's panes). */
export default function IssueDetail({
  issueKey,
  connectionId,
}: {
  issueKey: string;
  /** Which connection it is on, when its own link says (a key may be on two) */
  connectionId?: number;
}) {
  return <IssueBody issueKey={issueKey} connectionId={connectionId} variant="page" />;
}
