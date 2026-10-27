import { FileClock, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { dateFormat, t } from "@/i18n";
import { deleteDraft, draftPath, type NoteDraft } from "./drafts";

export function LocalDrafts({
  drafts,
  remove,
}: {
  drafts: NoteDraft[];
  remove: () => void;
}) {
  const date = dateFormat({ dateStyle: "short", timeStyle: "short" });
  return (
    <section
      aria-labelledby="local-drafts-title"
      className="border-t px-3 py-3"
    >
      <h2
        id="local-drafts-title"
        className="mb-2 flex items-center gap-2 text-caption font-medium text-muted-foreground"
      >
        <FileClock className="h-4 w-4" />
        {t("pages.notes.localDrafts")}
      </h2>
      {!drafts.length ? (
        <p className="px-1 py-2 text-caption text-muted-foreground">
          {t("pages.notes.noDrafts")}
        </p>
      ) : (
        <ul className="grid gap-1">
          {drafts.map(draft => (
            <li
              key={`${draft.noteId ?? "new"}:${draft.draftId}:${draft.tabId}`}
              className="group flex min-w-0 items-center gap-1"
            >
              <Link
                to={draftPath(draft)}
                className="min-w-0 flex-1 rounded-md px-2 py-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block truncate text-body-sm">
                  {draft.title || t("pages.notes.untitled")}
                </span>
                <time
                  className="block text-caption text-muted-foreground"
                  dateTime={new Date(draft.updatedAt).toISOString()}
                >
                  {date.format(new Date(draft.updatedAt))}
                </time>
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("pages.notes.deleteLocalDraft", {
                  title: draft.title || t("pages.notes.untitled"),
                })}
                onClick={() => {
                  deleteDraft(draft);
                  remove();
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
