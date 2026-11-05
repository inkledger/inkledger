import { useState, type DragEvent } from "react";
import { ISSUE_DRAG_TYPE, readIssueDragData, type DraggedIssue } from "@/lib/issues";

/**
 * A place to drop an issue dragged from a list or the board: `over` while one is above it, `drop`
 * props for the element, `onIssue` told of the issue dropped.
 */
export function useIssueDrop(onIssue: (issue: DraggedIssue) => void) {
  const [over, setOver] = useState(false);
  const drop = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(ISSUE_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      setOver(false);
      const issue = readIssueDragData(e.dataTransfer);
      if (!issue) return;
      e.preventDefault();
      onIssue(issue);
    },
  };
  return { over, drop };
}
