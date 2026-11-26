import { Navigate, useParams, useSearchParams } from "react-router";
import { MessageSquarePlus } from "lucide-react";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { lazyPart } from "@/components/app/lazyPart";
import { openFeedback } from "@/lib/flag";
import { t } from "@/i18n";

const FeedbackPanel = lazyPart(() => import("@/components/feedback/FeedbackPanel").then(m => m.FeedbackPanel));

/**
 * Feedback: what everyone told this server's administrators about the app, each one at
 * /feedback/:id. "New feedback" is always in the header: one sent never hides the way to the next.
 */
export default function FeedbackPage() {
  const { id } = useParams();
  const selected = id && /^\d+$/.test(id) ? Number(id) : null;
  return (
    <>
      <PageHeader
        sticky
        title={t("ui.feedback.nav")}
        description={t("pages.feedback.description")}
        actions={
          <Button size="sm" onClick={() => openFeedback()}>
            <MessageSquarePlus className="mr-1.5 h-4 w-4" aria-hidden />
            {t("pages.feedback.new")}
          </Button>
        }
      />
      <FeedbackPanel selected={selected} />
    </>
  );
}

/** Where Feedback used to be (Info's tab: /info/feedback, /info/feedback/:id, /info?tab=feedback): the same list, filters and one kept. */
export function OldFeedbackLink() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  next.delete("tab");
  const query = next.toString();
  return <Navigate replace to={`/feedback${id && /^\d+$/.test(id) ? `/${id}` : ""}${query ? `?${query}` : ""}`} />;
}
