import { dayReview } from "@/lib/flag";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { lazyPart } from "@/components/app/lazyPart";

const DayReviewBody = lazyPart(() => import("@/components/DayReviewBody").then(m => m.DayReviewBody));

/**
 * End-of-day review (Timing-style): every unlogged timer with editable
 * duration and comment, the free gaps of the day, one confirmed batch to Jira.
 */
export function DayReview() {
  const open = dayReview.useValue();
  return (
    <Sheet open={open} onOpenChange={dayReview.set}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-lg">
        {open && <DayReviewBody />}
      </SheetContent>
    </Sheet>
  );
}
