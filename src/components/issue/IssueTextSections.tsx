import { PanelSection } from "@/components/app/Panel";
import { CommentsSection } from "@/components/issue/CommentsSection";
import { PrivateNotesSection } from "@/components/issue/PrivateNotesSection";
import { LinkedNotesSection } from "@/components/issue/LinkedNotesSection";
import { DescriptionSection } from "@/components/issue/DescriptionSection";
import { AttachmentsSection } from "@/components/issue/AttachmentsSection";
import { OtherFields } from "@/components/issue/OtherFields";
import { RemoteLinks } from "@/components/issue/RemoteLinks";
import { IssueMails } from "@/components/mail/IssueMails";
import { TodoList } from "@/components/todo/TodoList";
import { LazySection } from "@/components/issue/LazySection";
import type { Issue, IssueData } from "@/components/issue/useIssueData";
import { t } from "@/i18n";

/**
 * The issue's text: description, TODOs, private and linked notes, mails and comments.
 * `lazy` (a pane) mounts the mails and comments once they near the screen; `idScope`
 * keeps the composers' ids unique where the same key could be shown twice.
 */
export function IssueTextSections({
  issue: i,
  className,
  lazy = false,
  idScope = "",
}: {
  issue: Issue;
  className: string;
  lazy?: boolean;
  idScope?: string;
}) {
  return (
    <div className={className}>
        <PanelSection
          title={t("pages.issueDetail.description")}
          className="border-b"
        >
          <DescriptionSection
            issueKey={i.key}
            connectionId={i.connectionId}
          />
        </PanelSection>
        {i.connectionId ? (
          <PanelSection title={t("pages.issueDetail.todos")} className="border-b">
            <TodoList scope={{ issueKey: i.key, connectionId: i.connectionId }} />
          </PanelSection>
        ) : null}
        <PanelSection
          title={t("pages.issueDetail.privateNotes")}
          className="border-b"
        >
          <PrivateNotesSection
            issueKey={i.key}
            connectionId={i.connectionId}
            inputId={`private-note-${idScope}${i.key}`}
          />
        </PanelSection>
        {i.connectionId && <PanelSection title={t("pages.notes.linkedNotes")} className="border-b"><LinkedNotesSection issueKey={i.key} connectionId={i.connectionId} /></PanelSection>}
        {i.connectionId && (
          <LazySection lazy={lazy}>
            <PanelSection title={t("ui.mail.title")} className="border-b">
              <IssueMails issueKey={i.key} connectionId={i.connectionId} />
            </PanelSection>
          </LazySection>
        )}
        <LazySection lazy={lazy}>
          <PanelSection title={t("pages.issueDetail.comments")}>
            <CommentsSection
              issueKey={i.key}
              connectionId={i.connectionId}
              inputId={`comment-${idScope}${i.key}`}
            />
          </PanelSection>
        </LazySection>
    </div>
  );
}

/** What hangs off the issue: attachments, its other fields and its links elsewhere (`lazy` as above). */
export function IssueAttachedSections({
  issue: i,
  data: { offers },
  lazy = false,
}: {
  issue: Issue;
  data: IssueData;
  lazy?: boolean;
}) {
  return (
    <>
      {offers.attachments && (
        <LazySection lazy={lazy}>
          <PanelSection title={t("pages.issueDetail.attachments")}>
            <AttachmentsSection
              issueKey={i.key}
              connectionId={i.connectionId}
            />
          </PanelSection>
        </LazySection>
      )}
      <LazySection lazy={lazy}>
        <OtherFields issueKey={i.key} connectionId={i.connectionId} />
      </LazySection>
      <LazySection lazy={lazy}>
        <RemoteLinks issueKey={i.key} connectionId={i.connectionId} />
      </LazySection>
    </>
  );
}
