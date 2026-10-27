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
