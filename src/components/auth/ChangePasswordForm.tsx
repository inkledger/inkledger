import { useState } from "react";
import { PASSWORD_MIN_LENGTH } from "@contracts/accounts";
import { trpc } from "@/lib/trpc";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

/** Current and new password; on success the session's account is refreshed. */
export function ChangePasswordForm({ onDone, username }: { onDone?: () => void; username?: string | null }) {
  const utils = trpc.useUtils();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const change = trpc.auth.changePassword.useMutation({
    onSuccess: user => {
      utils.auth.me.setData(undefined, user);
      setCurrent("");
      setNext("");
      onDone?.();
    },
    onError: e => setError(e.message),
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        setError(null);
        change.mutate({ current, next });
      }}
    >
      <input type="text" name="username" autoComplete="username" value={username ?? ""} readOnly hidden />
      <div className="grid gap-2">
        <Label htmlFor="current-password">{t("pages.changePassword.current")}</Label>
        <Input id="current-password" type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="next-password">{t("pages.changePassword.next")}</Label>
        <Input id="next-password" type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
        <p className="text-caption text-muted-foreground">{t("pages.login.passwordRule", { min: PASSWORD_MIN_LENGTH })}</p>
      </div>
      <FormError message={error} />
      <Button type="submit" disabled={change.isPending} className="w-full">
        {t("pages.changePassword.submit")}
      </Button>
    </form>
  );
}
