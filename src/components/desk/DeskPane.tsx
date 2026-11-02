import type { CSSProperties } from "react";
import { IssueBody } from "@/components/issue/IssueBody";
import { PaneHeader, type PaneControls } from "@/components/desk/PaneHeader";
import { cn } from "@/lib/utils";

/**
 * One issue on the desk. The keyboard talks to it once it holds the focus or is
 * clicked; hidden (another pane maximized, another tab on a phone) it stays
 * mounted, with its scroll and what was typed in it.
 */
export function DeskPane({
  id,
  controls,
  hidden = false,
  style,
  className,
  onFocusPane,
}: {
  id: string;
  controls: PaneControls;
  hidden?: boolean;
  style?: CSSProperties;
  className?: string;
  onFocusPane: (id: string) => void;
}) {
  return (
    <section
      id={`desk-pane-${id}`}
      data-desk-pane={id}
      // "KEY · title" from the header once the issue is read; the key until then.
      aria-labelledby={`desk-pane-label-${id}`}
      aria-label={controls.issueKey}
      aria-current={controls.active && controls.several ? "true" : undefined}
      tabIndex={-1}
      hidden={hidden}
      style={style}
      onPointerDownCapture={() => onFocusPane(id)}
      onFocusCapture={() => onFocusPane(id)}
      // Being moved: faded under the highlight of where it goes.
      className={cn("min-h-0 min-w-0 bg-card outline-none data-[snap-dragging]:opacity-60", className)}
    >
      <IssueBody
        variant="pane"
        issueKey={controls.issueKey}
        connectionId={controls.connectionId}
        active={controls.active}
        // Beside other panes, one column: two inside a pane read as one more pane.
        maxSize={controls.several && !controls.maximized ? "m" : "l"}
        scrollKeyPrefix="desk"
        header={pane => <PaneHeader {...pane} controls={controls} />}
      />
    </section>
  );
}
