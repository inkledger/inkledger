import type { NoteTreeItem } from "@contracts/notes";

export type NoteNode = NoteTreeItem & { children: NoteNode[] };

export function buildNoteTree(items: NoteTreeItem[]): NoteNode[] {
  const nodes = new Map(
    items.map(item => [item.id, { ...item, children: [] as NoteNode[] }])
  );
  const roots: NoteNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function descendantsOf(items: NoteTreeItem[], id: string): Set<string> {
  const result = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parentId && result.has(item.parentId) && !result.has(item.id)) {
        result.add(item.id);
        changed = true;
      }
    }
  }
  return result;
}

export function ancestorIds(items: NoteTreeItem[], id: string): string[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id);
  while (current?.parentId && !seen.has(current.parentId)) {
    result.push(current.parentId);
    seen.add(current.parentId);
    current = byId.get(current.parentId);
  }
  return result;
}

export function siblingIndices(
  items: NoteTreeItem[],
  id: string,
  parentId: string | null
): number[] {
  return items
    .filter(item => item.parentId === parentId && item.id !== id)
    .map((_, index) => index);
}

/**
 * Where "new" goes from a selection: the selected folder itself, else the
 * folder holding the selected note (its nearest folder up), else the top level.
 */
export function folderTarget(
  items: NoteTreeItem[],
  id: string | undefined
): string | null {
  if (!id) return null;
  const byId = new Map(items.map(item => [item.id, item]));
  const self = byId.get(id);
  if (self?.kind === "folder") return self.id;
  for (const ancestor of ancestorIds(items, id)) {
    if (byId.get(ancestor)?.kind === "folder") return ancestor;
  }
  return null;
}

/** A folder name not taken beside it: the base, else "base 2", "base 3"… */
export function freeName(
  items: NoteTreeItem[],
  parentId: string | null,
  base: string,
  numbered: (n: number) => string
): string {
  const taken = new Set(
    items
      .filter(item => item.parentId === parentId)
      .map(item => item.title.trim().toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = numbered(n);
    if (!taken.has(name.toLowerCase())) return name;
  }
}
