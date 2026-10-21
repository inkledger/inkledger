import { Check, Plus, Settings2 } from "lucide-react";
import { currentProfileUrl, useNativeProfiles } from "@/hooks/useNativeProfiles";
import { Link } from "react-router";
import { openProfile, type ServerProfile } from "@/lib/native";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Account menu, native app only: the server profiles (another Jira, another
 * user) right in the menu, one click to switch. The menu content mounts on
 * open, so the list is reloaded every time.
 */
export function NativeServerMenu() {
  const { profiles } = useNativeProfiles();
  if (!profiles) return null;
  const here = currentProfileUrl();
  const switchTo = (url: string) =>
    openProfile(url).catch((e: unknown) => toast.error(String(e)));
  const several = profiles.list.length > 1;

  return (
    <>
      {several && (
        <>
          <DropdownMenuLabel className="text-overline uppercase text-muted-foreground">
            {t("ui.server.profiles")}
          </DropdownMenuLabel>
          {profiles.list.map(p => {
            const current = p.url === here;
            return (
              <DropdownMenuItem
                key={p.url}
                disabled={current}
                onClick={() => void switchTo(p.url)}
                className="gap-2 data-[disabled]:opacity-100"
              >
                <ProfileRow profile={p} current={current} />
              </DropdownMenuItem>
            );
          })}
        </>
      )}
      <DropdownMenuItem asChild>
        <Link to="/settings/servers">
          {several ? (
            <Settings2 className="mr-2 h-4 w-4" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          {several ? t("ui.server.manage") : t("ui.server.add")}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

/** One profile: initials, name, who and which Jira; a check on the one in use. */
export function ProfileRow({ profile: p, current }: { profile: ServerProfile; current: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
          current ? "bg-primary-soft text-primary-strong" : "bg-muted text-muted-foreground"
        )}
      >
        {p.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{p.name}</span>
        {(p.user || p.jira) && (
          <span className="block truncate text-caption text-muted-foreground">
            {[p.user, p.jira].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      {current && (
        <Check className="h-4 w-4 shrink-0 text-primary-strong" aria-label={t("ui.server.current")} />
      )}
    </>
  );
}
