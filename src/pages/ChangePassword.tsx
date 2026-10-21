import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { AuthShell } from "@/components/auth/AuthShell";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** A default or temporary password: nothing else opens until it is replaced. */
export default function ChangePassword() {
  useDocumentTitle(t("pages.changePassword.pageTitle"));
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = trpc.auth.logout.useMutation({
    onSettled: () => {
      queryClient.clear();
      void navigate("/login", { replace: true, state: { signedOut: true } });
    },
  });
  return (
    <AuthShell
      heading={t("pages.changePassword.heading")}
      intro={t("pages.changePassword.introDefault")}
      footer={
        <Button variant="ghost" className="mt-3 w-full" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {t("pages.changePassword.signOut")}
        </Button>
      }
    >
      <ChangePasswordForm username={user?.username} />
    </AuthShell>
  );
}
