import { ExternalLink } from "lucide-react";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import type { JiraLogin } from "@/lib/jiraLogin";

/** A Jira login (site, user, secret), as activating an account or connecting Jira asks for it. */
export function JiraLoginFields({ value, onChange, idPrefix = "jira" }: { value: JiraLogin; onChange: (v: JiraLogin) => void; idPrefix?: string }) {
  const set = (patch: Partial<JiraLogin>) => onChange({ ...value, ...patch });
  const { deployment, authType } = value;
  return (
    <>
      <SegmentedControl
        label={t("pages.login.deploymentLabel")}
        value={deployment}
        onChange={d => set({ deployment: d })}
        className="w-full [&>button]:flex-1 [&>button]:justify-center"
        options={[
          { value: "server", label: t("pages.login.server") },
          { value: "cloud", label: t("pages.login.cloud") },
        ]}
      />

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-site`}>{t("pages.login.siteUrl")}</Label>
        <Input
          id={`${idPrefix}-site`}
          placeholder={deployment === "server" ? t("pages.login.sitePlaceholderServer") : t("pages.login.sitePlaceholderCloud")}
          value={value.siteUrl}
          onChange={e => set({ siteUrl: e.target.value })}
          required
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-username`}>
          {deployment === "server" ? t("pages.login.username") : t("pages.login.atlassianEmail")}
        </Label>
        <Input
          id={`${idPrefix}-username`}
          type={deployment === "cloud" ? "email" : "text"}
          placeholder={deployment === "server" ? t("pages.login.usernamePlaceholder") : t("pages.login.emailPlaceholder")}
          value={value.username}
          onChange={e => set({ username: e.target.value })}
          autoComplete="off"
          required
        />
      </div>

      {deployment === "server" && (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-auth-type`}>{t("pages.login.authMethod")}</Label>
          <Select value={authType} onValueChange={v => set({ authType: v === "bearer" ? "bearer" : "basic" })}>
            <SelectTrigger id={`${idPrefix}-auth-type`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="basic">{t("pages.login.authBasic")}</SelectItem>
              <SelectItem value="bearer">{t("pages.login.authBearer")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-secret`}>
          {deployment === "cloud" ? t("pages.login.apiToken") : authType === "bearer" ? t("pages.login.pat") : t("pages.login.password")}
        </Label>
        <Input
          id={`${idPrefix}-secret`}
          type="password"
          placeholder="••••••••••••"
          value={value.secret}
          onChange={e => set({ secret: e.target.value })}
          autoComplete="off"
          required
        />
        {deployment === "cloud" ? (
          <a
            href="https://id.atlassian.com/manage-profile/security/api-tokens"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-caption font-medium underline-offset-4 hover:underline"
          >
            {t("pages.login.createToken")}
            <ExternalLink className="h-3 w-3" aria-hidden />
            <span className="sr-only">{t("pages.login.newTab")}</span>
          </a>
        ) : (
          <p className="text-caption text-muted-foreground">
            {authType === "bearer" ? t("pages.login.patHint") : t("pages.login.passwordHint")}
          </p>
        )}
      </div>
    </>
  );
}
