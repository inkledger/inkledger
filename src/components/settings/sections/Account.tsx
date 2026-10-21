import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { useState } from "react";
import { KeyRound, Link2, LogOut, RefreshCw, ShieldOff } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { initials } from "@/lib/initials";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/SettingsGroup";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useConnections, useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";

export function AccountSection() {
  const provider = useProviderName();
  const { user } = useAuth();
  const [changing, setChanging] = useState(false);
  const trackers = useConnections().data ?? [];
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const reimport = trpc.worklogs.reimport.useMutation({
    onSuccess: r => {
      void utils.invalidate();
      toast.success(t("settings.account.imported", { count: r.imported, provider }));
    },
    onError: e =>
      toast.error(t("settings.account.importFailed", { message: e.message })),
  });
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => {
      queryClient.clear();
      void navigate("/login", { replace: true, state: { signedOut: true } });
    },
    onError: () => toast.error(t("settings.account.signOutFailed")),
  });
  // Signs out too: what is left of the session would only lead back here.
  const forget = trpc.auth.forget.useMutation({
    onSuccess: () => logout.mutate(),
    onError: () => toast.error(t("settings.account.forgetFailed")),
  });

  return (
    <>
      <SettingsGroup
        id="account-profile"
        title={t("settings.account.signIn")}
        keywords={`${t("settings.account.profileKeywords")} ${t("settings.account.signInKeywords")}`}
      >
        <div className="flex items-center gap-4">
          <Avatar className="h-12 w-12">
            {user?.avatarUrl && <AvatarImage src="/api/me/avatar" alt="" />}
            <AvatarFallback className="bg-primary-soft font-medium text-primary-strong">
              {user ? initials(user.displayName) : "?"}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-semibold">{user?.displayName ?? "—"}</p>
            <p className="truncate text-body-sm text-muted-foreground">
              {user?.username ?? "—"} ·{" "}
              {user?.role === "admin"
                ? t("settings.users.admin")
                : t("settings.users.member")}
            </p>
          </div>
        </div>
        <SettingsRow
          label={t("settings.account.changePassword")}
          hint={t("settings.account.changePasswordHint")}
        >
          <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
            <KeyRound />
            {t("settings.account.changePasswordButton")}
          </Button>
        </SettingsRow>
        <Dialog open={changing} onOpenChange={setChanging}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("settings.account.changePassword")}</DialogTitle>
              <DialogDescription>
                {t("settings.account.changePasswordHint")}
              </DialogDescription>
            </DialogHeader>
            <ChangePasswordForm
              username={user?.username}
              onDone={() => {
                setChanging(false);
                toast.success(t("settings.account.passwordChanged"));
              }}
            />
          </DialogContent>
        </Dialog>
      </SettingsGroup>
      <SettingsGroup
        id="account-jira"
        title={t("settings.categories.connections.label")}
        keywords={t("settings.account.jiraKeywords")}
      >
        <SettingsRow
          label={trackers.length ? trackers.map(c => c.label || `${c.name} · ${c.host}`).join(", ") : t("settings.account.jiraNotConnected")}
          hint={trackers.length ? undefined : t("settings.account.jiraNone")}
        >
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/connections">
              <Link2 />
              {t("settings.connections.title")}
            </Link>
          </Button>
        </SettingsRow>
      </SettingsGroup>
      {trackers.some(c => c.capabilities && "time" in c.capabilities && c.capabilities.time.mode === "entries") && (
        <SettingsGroup
          id="account-worklogs"
          title={t("settings.account.times", { provider })}
          description={t("settings.account.timesDescription", { provider })}
          keywords={t("settings.account.timesKeywords")}
        >
          <SettingsRow
            label={t("settings.account.reimport")}
            hint={t("settings.account.reimportHint", { provider })}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={reimport.isPending}
              onClick={() => reimport.mutate()}
            >
              <RefreshCw
                className={reimport.isPending ? "animate-spin" : undefined}
              />
              {reimport.isPending
                ? t("settings.account.importing")
                : t("settings.account.reimportButton")}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      )}
      <SettingsGroup
        id="account-session"
        title={t("settings.account.session")}
        keywords={t("settings.account.sessionKeywords")}
      >
        <SettingsRow
          label={t("settings.account.signOut")}
          hint={t("settings.account.signOutHint")}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            <LogOut />
            {t("settings.account.signOutButton")}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t("settings.account.forget")}
          hint={t("settings.account.forgetHint")}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={forget.isPending || logout.isPending}
            onClick={() => forget.mutate()}
          >
            <ShieldOff />
            {t("settings.account.forgetButton")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
