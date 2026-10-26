import { failureText, toastError } from "@/lib/errorText";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Settings2 } from "lucide-react";
import { PASSWORD_MIN_LENGTH } from "@contracts/accounts";
import { trpc } from "@/lib/trpc";
import { manageProfiles, openProfile } from "@/lib/native";
import { currentProfileUrl, useNativeProfiles } from "@/hooks/useNativeProfiles";
import { ProfileRow } from "@/components/NativeServerMenu";
import { AuthShell, FormError } from "@/components/auth/AuthShell";
import { JiraLoginFields } from "@/components/auth/JiraLoginFields";
import { emptyJiraLogin, jiraLoginPayload } from "@/lib/jiraLogin";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useSignedIn } from "@/hooks/useSignedIn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

export default function Login() {
  useDocumentTitle(t("pages.login.pageTitle"));
  const location = useLocation();
  const state = location.state as { from?: string; signedOut?: boolean } | null;
  // Just signed out on purpose: no automatic way back in.
  const signedOut = state?.signedOut === true;
  const utils = trpc.useUtils();
  const signedIn = useSignedIn(state?.from ?? "/");
  const [mode, setMode] = useState<"signIn" | "activate">("signIn");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [jira, setJira] = useState(emptyJiraLogin);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const login = trpc.auth.login.useMutation({ onSuccess: signedIn, onError: e => setError(failureText(e)) });
  const activate = trpc.auth.activate.useMutation({ onSuccess: signedIn, onError: e => setError(failureText(e)) });

  // This device remembers who signed in: back in with one click, or by
  // itself when the session just ran out or a profile was switched to.
  const remembered = trpc.auth.remembered.useQuery(undefined, { retry: false });
  const [manual, setManual] = useState(false);
  const resume = trpc.auth.resume.useMutation({
    onSuccess: signedIn,
    onError: e => {
      setError(failureText(e));
      setManual(true);
      void utils.auth.remembered.invalidate();
    },
  });
  const autoTried = useRef(false);
  const who = remembered.data;
  useEffect(() => {
    if (!who || signedOut || autoTried.current) return;
    autoTried.current = true;
    resume.mutate();
  }, [who, signedOut, resume]);

  // Native app: the other servers are one click away, signed in or not.
  const { profiles } = useNativeProfiles();
  const here = currentProfileUrl();
  const switchTo = (url: string) => openProfile(url).catch((e: unknown) => toastError(e));

  const switchMode = (next: typeof mode) => {
    setError(null);
    setMode(next);
  };

  const profilesNav = profiles && profiles.list.length > 1 && (
    <nav aria-label={t("pages.login.otherProfiles")} className="mt-6 border-t pt-4">
      <h2 className="mb-2 text-overline uppercase text-muted-foreground">{t("pages.login.profiles")}</h2>
      <ul className="grid gap-1">
        {profiles.list.map(p => (
          <li key={p.url}>
            <button
              type="button"
              disabled={p.url === here}
              onClick={() => void switchTo(p.url)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body-sm transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent"
            >
              <ProfileRow profile={p} current={p.url === here} />
            </button>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" className="mt-1" onClick={() => void manageProfiles()}>
        <Settings2 className="h-4 w-4" aria-hidden />
        {t("pages.login.manageServers")}
      </Button>
    </nav>
  );

  if (mode === "activate") {
    return (
      <AuthShell heading={t("pages.login.activateHeading")} intro={t("pages.login.activateIntro")} footer={profilesNav}>
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            setError(null);
            activate.mutate({ ...jiraLoginPayload(jira), newUsername, newPassword });
          }}
        >
          <fieldset className="grid gap-4">
            <legend className="mb-2 text-overline uppercase text-muted-foreground">{t("pages.login.jiraSection")}</legend>
            <JiraLoginFields value={jira} onChange={setJira} />
          </fieldset>
          <fieldset className="grid gap-4 border-t pt-4">
            <legend className="mb-2 text-overline uppercase text-muted-foreground">{t("pages.login.newAccountSection")}</legend>
            <div className="grid gap-2">
              <Label htmlFor="new-username">{t("pages.login.newUsername")}</Label>
              <Input id="new-username" value={newUsername} onChange={e => setNewUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">{t("pages.login.newPassword")}</Label>
              <Input id="new-password" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
              <p className="text-caption text-muted-foreground">{t("pages.login.passwordRule", { min: PASSWORD_MIN_LENGTH })}</p>
            </div>
          </fieldset>
          <FormError message={error} />
          <Button type="submit" disabled={activate.isPending} className="w-full">
            {activate.isPending ? t("pages.login.verifying") : t("pages.login.activateSubmit")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => switchMode("signIn")} className="w-full">
            {t("pages.login.backToSignIn")}
          </Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading={t("pages.login.heading")} intro={t("pages.login.intro")} footer={profilesNav}>
      {who && !manual ? (
        <div className="grid gap-3">
          {/* surface: none — outside the app stage */}
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-semibold text-primary-strong"
            >
              {who.displayName.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-body-sm font-medium">{who.displayName}</span>
              {who.username && <span className="block truncate text-caption text-muted-foreground">{who.username}</span>}
            </span>
          </div>
          <Button onClick={() => resume.mutate()} disabled={resume.isPending} className="w-full">
            {resume.isPending ? t("pages.login.signingIn") : t("pages.login.continueAs", { name: who.displayName })}
          </Button>
          <Button variant="ghost" onClick={() => setManual(true)} className="w-full">
            {t("pages.login.otherAccount")}
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            setError(null);
            login.mutate({ username, password });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="username">{t("pages.login.accountUsername")}</Label>
            <Input id="username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">{t("pages.login.accountPassword")}</Label>
            <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          <FormError message={error} />
          <Button type="submit" disabled={login.isPending} className="w-full">
            {login.isPending ? t("pages.login.signingIn") : t("pages.login.signInSubmit")}
          </Button>
          <button
            type="button"
            onClick={() => switchMode("activate")}
            className="text-center text-caption font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t("pages.login.activateLink")}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
