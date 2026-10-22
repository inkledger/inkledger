import { createIssueDialog } from "@/lib/flag";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { lazyPart } from "@/components/app/lazyPart";

const CreateIssueForm = lazyPart(() => import("@/components/issues/CreateIssueForm").then(m => m.CreateIssueForm));

/** "New issue" (key i, palette, Issues page): created on the tracker of the chosen project or repository, assigned to me by default. */
export function CreateIssueDialog() {
  const open = createIssueDialog.useValue();
  return (
    <Dialog open={open} onOpenChange={createIssueDialog.set}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open: every opening starts clean. */}
        {open && (
          <CreateIssueForm onClose={() => createIssueDialog.set(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
