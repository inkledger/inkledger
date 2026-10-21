import { Chip } from "@/components/app/Chip";
import { statusCategoryTone } from "@/lib/jira";

/** Jira status as a soft chip, tinted by its status category. */
export function StatusBadge({
  status,
  category,
  className,
}: {
  status: string;
  category: string;
  className?: string;
}) {
  return (
    <Chip
      variant="dot"
      tone={statusCategoryTone(category)}
      className={className}
    >
      {status}
    </Chip>
  );
}
