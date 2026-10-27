import type { NoteDocument } from "@contracts/notes";

const dirty = new Set<string>();
const listeners = new Map<string, Set<(note: NoteDocument) => void>>();

export function setNoteDirty(id: string, value: boolean): void {
  if (value) dirty.add(id);
  else dirty.delete(id);
}

export function isNoteDirty(id: string): boolean {
  return dirty.has(id);
}

export function onServerNote(
  id: string,
  listener: (note: NoteDocument) => void
): () => void {
  const group = listeners.get(id) ?? new Set<(note: NoteDocument) => void>();
  group.add(listener);
  listeners.set(id, group);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(id);
  };
}

export function publishServerNote(note: NoteDocument): void {
  listeners.get(note.id)?.forEach(listener => listener(note));
}
