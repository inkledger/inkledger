import { dayReview } from "@/lib/flag";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { lazyPart } from "@/components/app/lazyPart";
import { useDirtyClose } from "@/components/app/DirtyClose";

const DayReviewBody = lazyPart(() => import("@/components/DayReviewBody").then(m => m.DayReviewBody));

/**
 * End-of-day review (Timing-style): every unlogged timer with editable
 * duration and comment, the free gaps of the day, one confirmed batch to Jira.
 */
export function DayReview() {
  const open = dayReview.useValue();
  // Edited durations, comments or choices not logged yet: asked before they go.
  const guard = useDirtyClose(() => dayReview.set(false));
  return (
    <>
      {guard.confirm}
      <Sheet open={open} onOpenChange={o => (o ? dayReview.set(true) : guard.onOpenChange(false))}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-lg">
          {open && <DayReviewBody onDirty={guard.markDirty} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
