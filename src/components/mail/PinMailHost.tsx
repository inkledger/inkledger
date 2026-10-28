import { useEffect, useState } from "react";
import { pinMailDialog } from "@/lib/flag";
import { trpc } from "@/lib/trpc";
import { lazyPart } from "@/components/app/lazyPart";
import { openPinMail, takePinMailStart, type PinMailStart } from "./pinMail";
// The parsers (and zod, through contracts) stay out of the first load: fetched on a drop or a paste.
const readMail = () => import("./readMail");

// Its code stays out of the first load: fetched when the browser is free.
const PinMailDialog = lazyPart(() => import("./PinMailDialog").then(m => m.PinMailDialog));

/** Typing, or dropping into, a field: never taken for a mail. */
const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.closest("input, textarea, select, [contenteditable='true']") !== null);

/**
 * "Pin a mail" from anywhere: the palette, or a mail dropped or pasted on the
 * app outside a field (a place that takes a mail itself, an issue's mails,
 * handles it first). Words dragged out of Outlook (no file, no link) search
 * the mailbox, when signed in.
 */
export function PinMailHost() {
  const open = pinMailDialog.useValue();
  const [start, setStart] = useState<PinMailStart>({});
  const account = trpc.mails.account.useQuery(undefined, { staleTime: 5 * 60_000 });
  const signedIn = !!account.data?.account;

  useEffect(
    () =>
      pinMailDialog.subscribe(() => {
        if (pinMailDialog.get()) setStart(takePinMailStart());
      }),
    [],
  );

  useEffect(() => {
    const carries = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).some(t => t === "Files" || t === "text/uri-list" || t === "text/plain");
    const onDragOver = (e: DragEvent) => {
      if (!e.defaultPrevented && !editable(e.target) && carries(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || editable(e.target) || !e.dataTransfer) return;
      e.preventDefault();
      const data = e.dataTransfer;
      const text = data.getData("text/plain").trim();
      void readMail()
        .then(m => m.draftFromDrop(data))
        .then(draft => {
        if (draft) openPinMail({ draft });
        else if (signedIn && text && text.length <= 200 && !text.includes("\n")) openPinMail({ query: text });
      });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (editable(e.target) || !e.clipboardData) return;
      const file = Array.from(e.clipboardData.files).find(f => /\.eml$/i.test(f.name) || f.type === "message/rfc822");
      if (file) {
        e.preventDefault();
        void readMail()
          .then(m => m.draftFromFile(file))
          .then(d => d && openPinMail({ draft: d }));
        return;
      }
      const text = e.clipboardData.getData("text/plain");
      // Only an Outlook web link is taken (checked again by the parser): other pastes go on as usual.
      if (!/^\s*https:\/\/outlook\.(office|office365|live)\.com\/|^\s*https:\/\/outlook\.cloud\.microsoft\//i.test(text)) return;
      e.preventDefault();
      void readMail().then(m => {
        const draft = m.draftFromLink(text);
        if (draft) openPinMail({ draft });
      });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [signedIn]);

  return <PinMailDialog open={open} onOpenChange={pinMailDialog.set} initial={start.draft ?? null} query={start.query} />;
}
