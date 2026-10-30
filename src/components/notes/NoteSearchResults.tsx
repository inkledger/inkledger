import { Link } from "react-router";
import { FileText, Folder } from "lucide-react";
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
      className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 pb-2"
      aria-label={t("pages.notes.searchResults")}
    >
      {results.map(result => (
        <li
          key={result.id}
          className="min-w-0 rounded-md px-3 py-2 transition-colors hover:bg-accent/70"
        >
          <Link
            to={`/notes/${result.id}${search}`}
            aria-label={
              result.kind === "folder"
                ? `${result.title || t("pages.notes.untitled")}, ${t("pages.notes.folder")}`
                : undefined
            }
            className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-center gap-1.5 font-medium">
              {result.kind === "folder" ? (
                <Folder aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
              ) : (
                <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">
                {result.title || t("pages.notes.untitled")}
              </span>
            </span>
            {result.path.length > 0 && (
              <span className="block truncate text-caption text-muted-foreground">
                {result.path
                  .map(part => part.title || t("pages.notes.untitled"))
                  .join(" / ")}
              </span>
            )}
            {result.snippet && (
              <span className="mt-1 line-clamp-2 block [overflow-wrap:anywhere] text-body-sm text-muted-foreground">
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
