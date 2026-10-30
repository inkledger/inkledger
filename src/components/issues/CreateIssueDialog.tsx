import { createIssueDialog } from "@/lib/flag";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { lazyPart } from "@/components/app/lazyPart";
import { clearCreateIssuePrefill } from "@/lib/createIssue";

const CreateIssueForm = lazyPart(() => import("@/components/issues/CreateIssueForm").then(m => m.CreateIssueForm));

/** "New issue" (key i, palette, Issues page): created on the tracker of the chosen project or repository, assigned to me by default. */
export function CreateIssueDialog() {
  const open = createIssueDialog.useValue();
  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o) clearCreateIssuePrefill();
        createIssueDialog.set(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open: every opening starts clean. */}
        {open && (
          <CreateIssueForm
            onClose={() => {
              clearCreateIssuePrefill();
              createIssueDialog.set(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
