import { useState } from "react";
import { lazyPart } from "@/components/app/lazyPart";
import { notificationCenter } from "@/lib/flag";
import { Sheet, SheetContent } from "@/components/ui/sheet";

const NotificationCenterBody = lazyPart(() => import("@/components/notifications/NotificationCenterBody").then(m => m.NotificationCenterBody));

/**
 * Notification center: slides in from the right like macOS. Each notification can be read
 * here, opened, or archived without opening it. The list's code and polling live in the body,
 * which exists only while the sheet is open (the badge counts on its own).
 */
export function NotificationCenter() {
  const open = notificationCenter.useValue();
  // Which kinds to show (all, or one): kept here, so it outlives the body between openings.
  const [kind, setKind] = useState<string>("all");
  return (
    <Sheet open={open} onOpenChange={notificationCenter.set}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 bg-canvas p-0 sm:max-w-md"
      >
        <NotificationCenterBody kind={kind} setKind={setKind} />
      </SheetContent>
    </Sheet>
  );
}
