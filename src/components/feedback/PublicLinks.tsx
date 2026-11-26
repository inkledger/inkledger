import { ExternalLink } from "@/components/app/ExternalLink";
import { t } from "@/i18n";
import { publicRefs, type PublicFields } from "./labels";

/** "Public: #<issue> · PR #<pr> (draft)", on a feedback the developers made public. */
export function PublicLinks({ feedback }: { feedback: PublicFields }) {
  const refs = publicRefs(feedback);
  if (!refs) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm">
      <span className="text-muted-foreground">{t("pages.feedback.detail.public")}</span>
      <ExternalLink url={refs.issue.url}>{refs.issue.label}</ExternalLink>
      {refs.pr && (
        <>
          <span className="text-muted-foreground" aria-hidden>
            ·
          </span>
          <ExternalLink url={refs.pr.url}>{refs.pr.label}</ExternalLink>
        </>
      )}
    </p>
  );
}
