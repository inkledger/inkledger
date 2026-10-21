import { Star } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { t } from "@/i18n";

export function FavoriteStar({
  issueKey,
  connectionId,
  favorite,
  className,
}: {
  issueKey: string;
  connectionId?: number;
  favorite: boolean;
  className?: string;
}) {
  const utils = trpc.useUtils();
  const toggle = trpc.issues.toggleFavorite.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.issues.list.invalidate(),
        utils.issues.all.invalidate(),
        utils.issues.get.invalidate(),
      ]),
    onError: e => toast.error(e.message),
  });
  const label = t(favorite ? "ui.favorite.remove" : "ui.favorite.add", {
    key: issueKey,
  });
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label={label}
      aria-pressed={favorite}
      title={label}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate({ key: issueKey, connectionId })}
    >
      <Star
        className={cn(
          "h-4 w-4",
          favorite ? "fill-warning text-warning" : "text-muted-foreground"
        )}
      />
    </Button>
  );
}
