import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { failureText } from "@/lib/errorText";
import { t } from "@/i18n";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Target = { id: number; username: string | null; displayName: string };

/**
 * Erasing an account (users.erase), loaded only when an owner opens it: what goes and what
 * stays said first, then the account's username typed to confirm (the server checks it too).
 */
export default function EraseUser({ target, onClose, onErased }: { target: Target | null; onClose: () => void; onErased: () => void }) {
  const [typed, setTyped] = useState("");
  const erase = trpc.users.erase.useMutation({
    onSuccess: () => {
      toast.success(t("settings.users.erased"));
      setTyped("");
      onErased();
    },
  });
  const username = target?.username ?? "";
  const matches = username !== "" && typed.trim().toLowerCase() === username.toLowerCase();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={open => {
        if (open) return;
        setTyped("");
        erase.reset();
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.users.eraseTitle", { name: target?.displayName ?? "" })}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{t("settings.users.eraseHint", { id: target?.id ?? 0 })}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            if (target && matches) erase.mutate({ id: target.id, confirmUsername: typed.trim() });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="erase-confirm">{t("settings.users.eraseConfirmLabel", { username })}</Label>
            <Input
              id="erase-confirm"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              autoCapitalize="none"
              autoComplete="off"
              required
            />
          </div>
          <FormError message={erase.error ? failureText(erase.error) : null} />
          <Button type="submit" variant="destructive" disabled={!matches || erase.isPending}>
            <Trash2 />
            {t("settings.users.eraseButton")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
