import { Link } from "react-router";
import type { NoteSearchResult } from "@contracts/notes";
import { Chip } from "@/components/app/Chip";
import { issuePath } from "@/lib/issues";
import { t } from "@/i18n";

export function NoteSearchResults({
  results,
  search,
}: {
  results: NoteSearchResult[];
  search: string;
}) {
  return (
    <ul
      className="grid gap-1 px-2 pb-2"
      aria-label={t("pages.notes.searchResults")}
    >
      {results.map(result => (
        <li
          key={result.id}
          className="rounded-md px-3 py-2 transition-colors hover:bg-accent/70"
        >
          <Link
            to={`/notes/${result.id}${search}`}
            className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="block truncate font-medium">
              {result.title || t("pages.notes.untitled")}
            </span>
            {result.path.length > 0 && (
              <span className="block truncate text-caption text-muted-foreground">
                {result.path
                  .map(part => part.title || t("pages.notes.untitled"))
                  .join(" / ")}
              </span>
            )}
            {result.snippet && (
              <span className="mt-1 line-clamp-2 block text-body-sm text-muted-foreground">
                {result.snippet}
              </span>
            )}
          </Link>
          {result.issueKey && (
            <Link
              to={issuePath({
                key: result.issueKey,
                connectionId: result.connectionId,
              })}
              className="mt-1 inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Chip>{result.issueKey}</Chip>
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
