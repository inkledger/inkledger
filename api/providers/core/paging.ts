// Reading a pass: page after page from a checkpoint, each page handed over
// as it comes (the engine applies it at once, idempotently), the checkpoint
// only with the last. A token that comes back, or a pass with no end, is the
// adapter's fault: refused, never looped on.
import type { Checkpoint, Page, PageQuery, PageToken } from "../types";
import { IncompatibleResultError } from "./results";

/** The next page's address in a Link header (rel="next"), as given; null on the last page. */
export function nextLink(link: string | null): string | null {
  const m = link?.split(",").map((p) => /<([^>]+)>;\s*rel="next"/.exec(p)).find(Boolean);
  return m ? m[1] : null;
}

/** More pages than any real pass has: past it, the adapter is looping. */
export const MAX_PAGES = 1000;

export async function eachPage<T, G>(
  read: (q: PageQuery) => Promise<Page<T, G>>,
  since: Checkpoint | null,
  onPage: (items: T[], gone: G[]) => Promise<void> | void,
  maxPages = MAX_PAGES,
): Promise<{ checkpoint: Checkpoint | null; pages: number }> {
  const seen = new Set<PageToken>();
  let page: PageToken | null = null;
  for (let n = 0; n < maxPages; n++) {
    const p: Page<T, G> = await read({ since, page });
    await onPage(p.items, p.gone);
    if (p.last) return { checkpoint: p.checkpoint, pages: n + 1 };
    if (seen.has(p.next)) throw new IncompatibleResultError("a page token came back twice");
    seen.add(p.next);
    page = p.next;
  }
  throw new IncompatibleResultError("a pass longer than the page limit");
}

/** A whole pass in memory (tests, small passes). */
export async function readPass<T, G>(read: (q: PageQuery) => Promise<Page<T, G>>, since: Checkpoint | null, maxPages = MAX_PAGES) {
  const items: T[] = [];
  const gone: G[] = [];
  const { checkpoint, pages } = await eachPage(
    read,
    since,
    (i, g) => {
      items.push(...i);
      gone.push(...g);
    },
    maxPages,
  );
  return { items, gone, checkpoint, pages };
}
