import { Layers } from "lucide-react";
import { Link } from "react-router";
import { useBuckets } from "@/hooks/useBuckets";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

/** Which bucket this device shows: everything, or one of the user's buckets. */
export function BucketMenu() {
  const { buckets, active, choose } = useBuckets();
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Layers className="mr-2 h-4 w-4" />
          <span className="min-w-0 flex-1 truncate">{t("ui.buckets.showing", { name: active?.name ?? t("ui.buckets.everything") })}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          <DropdownMenuRadioGroup value={String(active?.id ?? "all")} onValueChange={v => choose(v === "all" ? null : Number(v))}>
            <DropdownMenuRadioItem value="all">{t("ui.buckets.everything")}</DropdownMenuRadioItem>
            {buckets.map(b => (
              <DropdownMenuRadioItem key={b.id} value={String(b.id)}>
                {b.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/settings/buckets">{t("ui.buckets.manage")}</Link>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  );
}
