import { useState } from "react";
import type { NoteDocument } from "@contracts/notes";
import { TIDY_MAX } from "@contracts/noteTidy";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import type { NoteDocumentController } from "./useNoteDocument";

type AiCopy = NonNullable<NoteDocument["ai"]>;
export type AiView = "original" | "ai";

/**
 * "Tidy up with AI" on a note: the model's copy waits beside the text
 * (Original | AI); the text changes only when the copy is kept, and the
 * original stays in the history. Without a local model: the note is copied
 * for any model, and its answer pasted back.
 */
export function useNoteAi(controller: NoteDocumentController) {
  const utils = trpc.useUtils();
  const llm = trpc.notes.llm.useQuery(undefined, { staleTime: 60_000 });
  // The copy as the server last said (the note), or as an action here just left it.
  const [override, setOverride] = useState<{
    id: string;
    ai: AiCopy | null;
  } | null>(null);
  const id = controller.currentId;
  const ai =
    override && override.id === id
      ? override.ai
      : (controller.note?.ai ?? null);
  const [view, setView] = useState<AiView>("original");
  const [byHand, setByHand] = useState(false);
  const tidy = trpc.notes.tidy.useMutation();
  const set = (next: AiCopy | null) => {
    if (id) setOverride({ id, ai: next });
    setView(next ? "ai" : "original");
    void utils.notes.tree.invalidate();
  };

  const run = async () => {
    if (!id) return;
    // The text as saved is what the model gets.
    await controller.flush();
    if (controller.getConflict()) return;
    if (!llm.data?.available || controller.body.length > TIDY_MAX) {
      setByHand(true);
      return;
    }
    try {
      set((await tidy.mutateAsync({ id })).ai);
    } catch (e) {
      toastError(e);
    }
  };

  return {
    ai,
    view: ai ? view : "original",
    setView,
    set,
    run,
    tidying: tidy.isPending,
    byHand,
    setByHand,
  };
}
export type NoteAi = ReturnType<typeof useNoteAi>;
