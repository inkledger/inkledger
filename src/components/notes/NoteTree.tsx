import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type { NoteTreeItem } from "@contracts/notes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/app/Chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { t } from "@/i18n";
import { buildNoteTree, descendantsOf, folderTarget, freeName, type NoteNode } from "./treeModel";
import { newNotePath } from "./paths";
import { MoveDialog } from "./NoteActions";

const untitled = (title: string) => title || t("pages.notes.untitled");

/** What a row's menu offers, the same from "…" and from a right-click. */
type MenuEntry = { key: string; label: string; icon: ReactNode; run: () => void; destructive?: boolean } | "separator";

/**
 * The notes as a file manager: folders and notes in one tree (ARIA tree,
 * arrows, Home/End, type-ahead), a click opens a note or a folder's view;
 * "…" or a right-click offers New folder here, New note here, Rename (also
 * F2), Move to…, Delete (also Delete/Backspace).
 */
export function NoteTree({
  items,
  selectedId,
  expanded,
  toggle,
  expand,
  search,
  beforeDelete,
  onDeleted,
  empty,
}: {
  items: NoteTreeItem[];
  selectedId?: string;
  expanded: Set<string>;
  toggle: (id: string) => void;
  /** Opens a folder or note in the tree (to show what was just made in it). */
  expand: (id: string) => void;
  search: string;
  /** Saves the open note first when it is going to the trash; false: don't delete. */
  beforeDelete: (ids: Set<string>) => Promise<boolean>;
  onDeleted: (ids: Set<string>) => void;
  /** Shown under the header while there is nothing yet. */
  empty: ReactNode;
}) {
  const roots = buildNoteTree(items);
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const treeRef = useRef<HTMLUListElement>(null);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const typed = useRef({ text: "", at: 0 });
  // The rename field closes once: Enter or Esc, then its blur (it leaves the page) is not a second answer.
  const closed = useRef<string | null>(null);
  // The row a closed rename field gives the focus back to, once it is drawn again (never later than the next key).
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (renaming !== null || !refocus.current) return;
    treeRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-id="${refocus.current}"]`)?.focus();
    refocus.current = null;
  }, [renaming]);
  const byId = new Map(items.map(item => [item.id, item]));
  const current = focusId && byId.has(focusId) ? focusId : selectedId && byId.has(selectedId) ? selectedId : roots[0]?.id;

  const refresh = () => {
    void utils.notes.tree.invalidate();
    void utils.notes.search.invalidate();
  };
  const createFolder = trpc.notes.createFolder.useMutation({
    onSuccess: row => {
      refresh();
      if (row.parentId) expand(row.parentId);
      setFocusId(row.id);
      setRenaming(row.id);
    },
    onError: (error: unknown) => toastError(error),
  });
  const rename = trpc.notes.rename.useMutation({
    onSuccess: (result, input) => {
      refresh();
      void utils.notes.get.invalidate({ id: input.id });
      if (result.status === "conflict") toast.error(t("pages.notes.renameConflict"));
    },
    onError: (error: unknown) => toastError(error),
  });
  const convert = trpc.notes.convertToFolder.useMutation({
    onSuccess: () => {
      refresh();
      toast.success(t("pages.notes.converted"));
    },
    onError: (error: unknown) => toastError(error),
  });
  const remove = trpc.notes.remove.useMutation({
    onSuccess: result => {
      toast.success(t("pages.notes.deleted", { count: result.count }));
      refresh();
      void utils.notes.trash.invalidate();
    },
    onError: (error: unknown) => toastError(error),
  });

  const newFolderIn = (parentId: string | null) =>
    createFolder.mutate({
      title: freeName(items, parentId, t("pages.notes.newFolder"), n => t("pages.notes.newFolderNumbered", { n })),
      parentId,
    });
  const open = (id: string) => {
    // A folder opened shows what it holds in the tree too (closing it stays possible).
    if (byId.get(id)?.kind === "folder") expand(id);
    void navigate(`/notes/${id}${search}`);
  };
  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    treeRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-id="${id}"]`)?.focus();
  };
  /** The rows on screen, top to bottom (closed branches' rows are not drawn). */
  const visible = () => [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].map(el => el.dataset.id ?? "");

  const entries = (node: NoteNode): MenuEntry[] => {
    const isFolder = node.kind === "folder";
    const here = isFolder ? node.id : null;
    const list: MenuEntry[] = [];
    if (isFolder) {
      list.push({ key: "folder", label: t("pages.notes.newFolderHere"), icon: <FolderPlus />, run: () => newFolderIn(here) });
      list.push({ key: "note", label: t("pages.notes.newNoteHere"), icon: <FilePlus2 />, run: () => void navigate(newNotePath(here)) });
      list.push("separator");
    } else {
      // A note holds notes (never folders): its own "new" is a sub-note.
      list.push({ key: "note", label: t("pages.notes.newNoteHere"), icon: <FilePlus2 />, run: () => void navigate(newNotePath(node.id)) });
      list.push("separator");
    }
    list.push({ key: "rename", label: t("pages.notes.rename"), icon: <Pencil />, run: () => setRenaming(node.id) });
    list.push({ key: "move", label: t("pages.notes.moveTo"), icon: <FolderInput />, run: () => setMoving(node.id) });
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!isFolder && !node.hasText && node.children.length > 0 && !node.issueKey && parent?.kind !== "note")
      list.push({ key: "convert", label: t("pages.notes.convertToFolder"), icon: <FolderSymlink />, run: () => convert.mutate({ id: node.id }) });
    list.push("separator");
    list.push({ key: "delete", label: t("pages.notes.delete"), icon: <Trash2 />, run: () => setDeleting(node.id), destructive: true });
    return list;
  };

  const onKey = (event: KeyboardEvent<HTMLElement>, node: NoteNode) => {
    if (event.target !== event.currentTarget) return; // typing in the rename field
    const isOpen = expanded.has(node.id);
    const rows = visible();
    const at = rows.indexOf(node.id);
    const go = (index: number) => {
      event.preventDefault();
      focusRow(rows[Math.max(0, Math.min(rows.length - 1, index))]);
    };
    switch (event.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(rows.length - 1);
      case "ArrowRight":
        event.preventDefault();
        if (!node.children.length) return;
        if (!isOpen) toggle(node.id);
        else focusRow(node.children[0]?.id);
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (node.children.length && isOpen) toggle(node.id);
        else focusRow(node.parentId ?? undefined);
        return;
      case "Enter":
        event.preventDefault();
        return open(node.id);
      case "F2":
        event.preventDefault();
        return setRenaming(node.id);
      case "Delete":
      case "Backspace":
        event.preventDefault();
        return setDeleting(node.id);
      case "ContextMenu":
        event.preventDefault();
        return setMenuFor(node.id);
      case "F10":
        if (event.shiftKey) {
          event.preventDefault();
          setMenuFor(node.id);
        }
        return;
    }
    // Type-ahead: the next row whose name starts with what was typed.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " ") {
      const now = event.timeStamp;
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
      const order = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
      const hit = order.find(id => untitled(byId.get(id)?.title ?? "").toLowerCase().startsWith(typed.current.text));
      if (hit) {
        event.preventDefault();
        focusRow(hit);
      }
    }
  };

  const commitRename = (node: NoteNode, value: string) => {
    if (closed.current === node.id) return;
    closed.current = node.id;
    refocus.current = node.id;
    setRenaming(null);
    const title = value.trim();
    if (!title) {
      toast.error(t("server.notes.nameRequired"));
      return;
    }
    if (title !== node.title) rename.mutate({ id: node.id, title, expectedRevision: node.contentRevision });
  };

  const renderNode = (node: NoteNode, level: number): ReactNode => {
    const isFolder = node.kind === "folder";
    const isOpen = expanded.has(node.id);
    const active = selectedId === node.id;
    const hasChildren = node.children.length > 0;
    const label = untitled(node.title);
    const list = entries(node);
    const Icon = isFolder ? (isOpen && hasChildren ? FolderOpen : Folder) : FileText;
    return (
      <li key={node.id} role="none">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              role="treeitem"
              data-id={node.id}
              aria-level={level}
              aria-label={isFolder ? `${label}, ${t("pages.notes.folder")}` : label}
              aria-expanded={hasChildren ? isOpen : undefined}
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              tabIndex={node.id === current ? 0 : -1}
              onFocus={event => {
                if (event.target === event.currentTarget) setFocusId(node.id);
              }}
              onKeyDown={event => onKey(event, node)}
              onClick={event => {
                // A menu item's click (drawn in a portal) reaches here through React: only the row's own opens.
                if (renaming === node.id || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
                open(node.id);
              }}
              {...surface("nav", { current: active, edge: false })}
              className={cn(
                "group flex min-h-9 min-w-0 cursor-pointer items-center rounded-md text-body-sm outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch",
                active && "bg-primary-soft text-primary-strong"
              )}
            >
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center text-muted-foreground"
                onClick={event => {
                  if (!hasChildren) return;
                  event.stopPropagation();
                  toggle(node.id);
                }}
              >
                {hasChildren ? isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" /> : null}
              </span>
              <Icon aria-hidden className={cn("mr-1.5 h-4 w-4 shrink-0", isFolder ? "text-primary" : "text-muted-foreground")} />
              {renaming === node.id ? (
                <Input
                  autoFocus
                  defaultValue={node.title}
                  maxLength={200}
                  aria-label={t("pages.notes.renameLabel", { title: label })}
                  className="h-7 min-w-0 flex-1"
                  onFocus={event => {
                    closed.current = null;
                    event.currentTarget.select();
                  }}
                  onClick={event => event.stopPropagation()}
                  onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === "Enter") commitRename(node, event.currentTarget.value);
                    if (event.key === "Escape") {
                      closed.current = node.id;
                      refocus.current = node.id;
                      setRenaming(null);
                    }
                  }}
                  onBlur={event => renaming === node.id && commitRename(node, event.currentTarget.value)}
                />
              ) : (
                <span className="min-w-0 flex-1 py-1.5">
                  <span className="block truncate">{label}</span>
                  {node.issueKey && <Chip className="mt-0.5 max-w-full truncate text-caption">{node.issueKey}</Chip>}
                </span>
              )}
              <DropdownMenu open={menuFor === node.id} onOpenChange={on => setMenuFor(on ? node.id : null)}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={t("pages.notes.actionsFor", { title: label })}
                    className="mr-1 size-7 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
                    onClick={event => event.stopPropagation()}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={event => event.preventDefault()}>
                  {list.map((entry, index) =>
                    entry === "separator" ? (
                      <DropdownMenuSeparator key={`s${index}`} />
                    ) : (
                      <DropdownMenuItem key={entry.key} variant={entry.destructive ? "destructive" : "default"} onSelect={entry.run}>
                        {entry.icon}
                        {entry.label}
                      </DropdownMenuItem>
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={event => event.preventDefault()}>
            {list.map((entry, index) =>
              entry === "separator" ? (
                <ContextMenuSeparator key={`s${index}`} />
              ) : (
                <ContextMenuItem key={entry.key} variant={entry.destructive ? "destructive" : "default"} onSelect={entry.run}>
                  {entry.icon}
                  {entry.label}
                </ContextMenuItem>
              )
            )}
          </ContextMenuContent>
        </ContextMenu>
        {hasChildren && isOpen && (
          <ul role="group" className="ml-4 grid gap-0.5 border-l pl-1">
            {node.children.map(child => renderNode(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };

  const target = folderTarget(items, selectedId);
  const deletingRow = deleting ? byId.get(deleting) : undefined;
  const movingRow = moving ? byId.get(moving) : undefined;
  return (
    <nav aria-label={t("pages.notes.tree")} className="px-2 py-2">
      <div className="mb-1 flex items-center justify-end gap-1 px-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("pages.notes.newFolder")}
          title={t("pages.notes.newFolder")}
          disabled={createFolder.isPending}
          onClick={() => newFolderIn(target)}
        >
          <FolderPlus />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("pages.notes.new")} title={t("pages.notes.new")} onClick={() => void navigate(newNotePath(target))}>
          <FilePlus2 />
        </Button>
      </div>
      {roots.length ? (
        <ul ref={treeRef} role="tree" aria-label={t("pages.notes.tree")} className="grid gap-0.5">
          {roots.map(node => renderNode(node, 1))}
        </ul>
      ) : (
        empty
      )}
      {movingRow && (
        <MoveDialog
          key={movingRow.id}
          id={movingRow.id}
          tree={items}
          open
          onOpenChange={on => !on && setMoving(null)}
        />
      )}
      <AlertDialog open={!!deletingRow} onOpenChange={on => !on && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deletingRow?.kind === "folder" ? t("pages.notes.deleteFolderTitle") : t("pages.notes.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingRow
                ? t(deletingRow.kind === "folder" ? "pages.notes.deleteFolderText" : "pages.notes.deleteText", {
                    count: descendantsOf(items, deletingRow.id).size - 1,
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              disabled={remove.isPending}
              onClick={() => {
                if (!deletingRow) return;
                const ids = descendantsOf(items, deletingRow.id);
                void beforeDelete(ids).then(ok => {
                  if (!ok) return;
                  remove.mutate({ id: deletingRow.id }, { onSuccess: () => onDeleted(ids) });
                });
              }}
            >
              {t("pages.notes.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
