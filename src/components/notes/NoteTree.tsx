import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { Link } from "react-router";
import type { NoteTreeItem } from "@contracts/notes";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/app/Chip";
import { issuePath } from "@/lib/issues";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { t } from "@/i18n";
import { buildNoteTree, type NoteNode } from "./treeModel";

export function NoteTree({
  items,
  selectedId,
  expanded,
  toggle,
  search,
}: {
  items: NoteTreeItem[];
  selectedId?: string;
  expanded: Set<string>;
  toggle: (id: string) => void;
  search: string;
}) {
  const roots = buildNoteTree(items);
  return (
    <nav aria-label={t("pages.notes.tree")} className="px-2 py-2">
      <ul className="grid gap-0.5">
        {roots.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            selectedId={selectedId}
            expanded={expanded}
            toggle={toggle}
            search={search}
          />
        ))}
      </ul>
    </nav>
  );
}

function TreeNode({
  node,
  selectedId,
  expanded,
  toggle,
  search,
}: {
  node: NoteNode;
  selectedId?: string;
  expanded: Set<string>;
  toggle: (id: string) => void;
  search: string;
}) {
  const open = expanded.has(node.id);
  const active = selectedId === node.id;
  return (
    <li>
      <div
        {...surface("nav", { current: active, edge: false })}
        className={cn(
          "group flex min-w-0 items-center rounded-md hover:bg-accent/60",
          active && "bg-primary-soft text-primary-strong"
        )}
      >
        {node.children.length ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            aria-label={t(
              open ? "pages.notes.collapse" : "pages.notes.expand",
              { title: node.title || t("pages.notes.untitled") }
            )}
            aria-expanded={open}
            onClick={() => toggle(node.id)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </Button>
        ) : (
          <span
            className="flex size-7 shrink-0 items-center justify-center"
            aria-hidden
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        )}
        <div className="min-w-0 flex-1 py-1.5 pr-2">
          <Link
            to={`/notes/${node.id}${search}`}
            aria-current={active ? "page" : undefined}
            className="block truncate rounded-sm text-body-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {node.title || t("pages.notes.untitled")}
          </Link>
          {node.issueKey && (
            <Link
              to={issuePath({
                key: node.issueKey,
                connectionId: node.connectionId,
              })}
              className="mt-0.5 inline-flex max-w-full rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Chip className="max-w-full truncate text-caption">
                {node.issueKey}
              </Chip>
            </Link>
          )}
        </div>
      </div>
      {node.children.length > 0 && open && (
        <ul className="ml-4 grid gap-0.5 border-l pl-1">
          {node.children.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              expanded={expanded}
              toggle={toggle}
              search={search}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
