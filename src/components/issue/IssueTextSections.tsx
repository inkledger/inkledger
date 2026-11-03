import { Tabs, TabPanel } from "@/components/ui/tabs";
import { deviceSetting } from "@/lib/storage";
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
        <YourWork issue={i} idScope={idScope} />
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

type WorkTab = "todos" | "notes" | "linked" | "mail";
/** Which of the issue's own parts was open last, remembered on this device. */
const workTab = deviceSetting<WorkTab>("ikl-issue-work-tab", raw => (raw === "notes" || raw === "linked" || raw === "mail" ? raw : "todos"), tab => (tab === "todos" ? null : tab));

/**
 * What is the user's own on an issue (its TODOs, private notes, linked notes, mail) in one block behind
 * tabs (docs/design-system.md §7.1): one shown at a time, every one a click away, instead of four stacked
 * sections, most of them empty. Only the open one is drawn (and read).
 */
function YourWork({ issue: i, idScope }: { issue: Issue; idScope: string }) {
  const chosen = workTab.use();
  const items: { value: WorkTab; label: string }[] = [
    ...(i.connectionId ? [{ value: "todos" as const, label: t("pages.issueDetail.todos") }] : []),
    { value: "notes" as const, label: t("pages.issueDetail.privateNotes") },
    ...(i.connectionId ? [{ value: "linked" as const, label: t("pages.notes.linkedNotes") }, { value: "mail" as const, label: t("ui.mail.title") }] : []),
  ];
  const tab = items.some(item => item.value === chosen) ? chosen : items[0].value;
  const idBase = `issue-work-${idScope}${i.key}`.replace(/[^\w-]/g, "-");
  return (
    <PanelSection title={t("pages.issueDetail.yourWork")} className="border-b">
      <Tabs idBase={idBase} label={t("pages.issueDetail.yourWork")} value={tab} onChange={next => workTab.set(next)} items={items} className="-mt-1 mb-3" />
      <TabPanel idBase={idBase} value="todos" current={tab}>
        {i.connectionId ? <TodoList scope={{ issueKey: i.key, connectionId: i.connectionId }} /> : null}
      </TabPanel>
      <TabPanel idBase={idBase} value="notes" current={tab}>
        <PrivateNotesSection issueKey={i.key} connectionId={i.connectionId} inputId={`private-note-${idScope}${i.key}`} />
      </TabPanel>
      <TabPanel idBase={idBase} value="linked" current={tab}>
        {i.connectionId ? <LinkedNotesSection issueKey={i.key} connectionId={i.connectionId} /> : null}
      </TabPanel>
      <TabPanel idBase={idBase} value="mail" current={tab}>
        {i.connectionId ? <IssueMails issueKey={i.key} connectionId={i.connectionId} /> : null}
      </TabPanel>
    </PanelSection>
  );
}
