import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useTrackerSites } from "@/hooks/useConnections";
import { NativeServerMenu } from "@/components/NativeServerMenu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { BucketMenu } from "@/components/BucketMenu";
import { surface, surfaceFace } from "@/components/app/surface";

/** The signed-in user: avatar, name and email, opening server and sign-out. */
export function AccountMenu({
  collapsed = false,
  side = "top",
}: {
  collapsed?: boolean;
  side?: "top" | "right";
}) {
  const { user } = useAuth();
  const sites = useTrackerSites();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => {
      queryClient.clear();
      void navigate("/login", { replace: true, state: { signedOut: true } });
    },
    onError: () => toast.error(t("ui.layout.logoutFailed")),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // The same open and closed in the sidebar: the avatar keeps its place, the name shows open.
          className="flex h-11 w-full shrink-0 items-center gap-3 rounded-md pl-3 pr-2 text-left transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {/* The avatar clips its picture: it stands on a wrapper. */}
          <span {...surface("picture", { role: "wrap" })} className="shrink-0 rounded-full">
          <Avatar {...surfaceFace()} className="h-9 w-9">
            {user?.avatarUrl && <AvatarImage src="/api/me/avatar" alt="" />}
            <AvatarFallback className="bg-primary-soft text-caption font-semibold text-primary-strong">
              {user?.displayName?.slice(0, 2).toUpperCase() ?? "?"}
            </AvatarFallback>
          </Avatar>
          </span>
          <span className={cn("min-w-0 flex-1", collapsed && "sr-only")}>
            <span className="block truncate text-body-sm font-medium">
              {user?.displayName}
            </span>
            <span className="block truncate text-caption text-muted-foreground">
              {user?.email}
            </span>
          </span>
          {!collapsed && (
            <ChevronsUpDown
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
            />
          )}
          <span className="sr-only">{t("ui.layout.accountMenu")}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} className="w-64">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          {sites[0]?.host ?? user?.username}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <BucketMenu />
        <NativeServerMenu />
        <DropdownMenuItem onClick={() => logout.mutate()}>
          <LogOut className="mr-2 h-4 w-4" />
          {t("ui.layout.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
