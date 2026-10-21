import { useState } from "react";
import { useParams } from "react-router";
import { PASSWORD_MIN_LENGTH } from "@contracts/accounts";
import { trpc } from "@/lib/trpc";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { AuthShell, FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { t } from "@/i18n";
import { useSignedIn } from "@/hooks/useSignedIn";

/** An invite link: the person chooses their password and is signed in. */
export default function Invite() {
  useDocumentTitle(t("pages.invite.pageTitle"));
  const { token = "" } = useParams();
  const invite = trpc.auth.invite.useQuery({ token }, { retry: false, enabled: token !== "" });
  const signedIn = useSignedIn("/");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const accept = trpc.auth.acceptInvite.useMutation({ onSuccess: signedIn, onError: e => setError(e.message) });

  if (invite.isPending && token) {
    return (
      <AuthShell heading={t("pages.invite.pageTitle")}>
        <Spinner className="h-6 w-6" />
      </AuthShell>
    );
  }
  if (!invite.data) {
    return (
      <AuthShell heading={t("pages.invite.pageTitle")}>
        <FormError message={t("pages.invite.invalid")} />
      </AuthShell>
    );
  }
  const { displayName, username } = invite.data;
  return (
    <AuthShell heading={t("pages.invite.heading", { name: displayName })} intro={t("pages.invite.intro", { username: username ?? "" })}>
      <form
        className="grid gap-4"
        onSubmit={e => {
          e.preventDefault();
          setError(null);
          accept.mutate({ token, password });
        }}
      >
        {/* For password managers: the account the password belongs to. */}
        <input type="text" name="username" autoComplete="username" value={username ?? ""} readOnly hidden />
        <div className="grid gap-2">
          <Label htmlFor="invite-password">{t("pages.invite.password")}</Label>
          <Input id="invite-password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
          <p className="text-caption text-muted-foreground">{t("pages.login.passwordRule", { min: PASSWORD_MIN_LENGTH })}</p>
        </div>
        <FormError message={error} />
        <Button type="submit" disabled={accept.isPending} className="w-full">
          {accept.isPending ? t("pages.login.signingIn") : t("pages.invite.submit")}
        </Button>
      </form>
    </AuthShell>
  );
}
