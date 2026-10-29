import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { FilePlus2, FileText, Folder, FolderPlus } from "lucide-react";
import type { NoteTreeItem } from "@contracts/notes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/app/States";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { dateFormat, t } from "@/i18n";
import { freeName } from "./treeModel";
import { newNotePath } from "./paths";

const untitled = (title: string) => title || t("pages.notes.untitled");

/**
 * A folder opened: what it holds (folders first, as in the tree), and
 * "New note here" / "New folder here" (where it is: the page's breadcrumb). A folder made here opens
 * its name for typing, as in the tree.
 */
export function FolderView({ folder, items, search }: { folder: NoteTreeItem; items: NoteTreeItem[]; search: string }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [renaming, setRenaming] = useState<string | null>(null);
  // Enter or Esc closes the field once; its blur as it leaves is not a second answer.
  const closed = useRef<string | null>(null);
  const children = items.filter(item => item.parentId === folder.id);
  const refresh = () => {
    void utils.notes.tree.invalidate();
    void utils.notes.search.invalidate();
  };
  const createFolder = trpc.notes.createFolder.useMutation({
    onSuccess: row => {
      refresh();
      setRenaming(row.id);
    },
    onError: (error: unknown) => toastError(error),
  });
  const rename = trpc.notes.rename.useMutation({
    onSuccess: result => {
      refresh();
      if (result.status === "conflict") toast.error(t("pages.notes.renameConflict"));
    },
    onError: (error: unknown) => toastError(error),
  });
  const commit = (item: NoteTreeItem, value: string) => {
    if (closed.current === item.id) return;
    closed.current = item.id;
    setRenaming(null);
    const title = value.trim();
    if (!title) return void toast.error(t("server.notes.nameRequired"));
    if (title !== item.title) rename.mutate({ id: item.id, title, expectedRevision: item.contentRevision });
  };
  const when = dateFormat({ dateStyle: "medium" });

  return (
    <section aria-label={t("pages.notes.folderContents", { title: untitled(folder.title) })} className="grid gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void navigate(newNotePath(folder.id))}>
          <FilePlus2 />
          {t("pages.notes.newNoteHere")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={createFolder.isPending}
          onClick={() =>
            createFolder.mutate({
              title: freeName(items, folder.id, t("pages.notes.newFolder"), n => t("pages.notes.newFolderNumbered", { n })),
              parentId: folder.id,
            })
          }
        >
          <FolderPlus />
          {t("pages.notes.newFolderHere")}
        </Button>
      </div>
      {children.length === 0 ? (
        <EmptyState art="inbox" title={t("pages.notes.folderEmpty")} message={t("pages.notes.folderEmptyText")} />
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] divide-y rounded-md border">
          {children.map(item => {
            const Icon = item.kind === "folder" ? Folder : FileText;
            return (
              <li key={item.id} className="min-w-0">
                {renaming === item.id ? (
                  <div className="flex min-h-touch items-center gap-2 px-3">
                    <Icon aria-hidden className="h-4 w-4 shrink-0 text-primary" />
                    <Input
                      autoFocus
                      defaultValue={item.title}
                      maxLength={200}
                      aria-label={t("pages.notes.renameLabel", { title: untitled(item.title) })}
                      className="h-8 min-w-0 flex-1"
                      onFocus={event => {
                        closed.current = null;
                        event.currentTarget.select();
                      }}
                      onKeyDown={event => {
                        if (event.key === "Enter") commit(item, event.currentTarget.value);
                        if (event.key === "Escape") {
                          closed.current = item.id;
                          setRenaming(null);
                        }
                      }}
                      onBlur={event => renaming === item.id && commit(item, event.currentTarget.value)}
                    />
                  </div>
                ) : (
                  <Link
                    to={`/notes/${item.id}${search}`}
                    className="flex min-h-touch min-w-0 items-center gap-2 px-3 py-2 text-body-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <Icon aria-hidden className={item.kind === "folder" ? "h-4 w-4 shrink-0 text-primary" : "h-4 w-4 shrink-0 text-muted-foreground"} />
                    <span className="min-w-0 flex-1 truncate">{untitled(item.title)}</span>
                    <span className="shrink-0 text-caption text-muted-foreground">{when.format(item.updatedAt)}</span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
