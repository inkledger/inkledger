/** How many favourites the Issues page draws above the list until "Show all". */
export const PINNED_FIRST = 5;

/** The favourites drawn: the first few, or all of them once "Show all" is on. */
export function pinnedDrawn<T>(ordered: T[], all: boolean): T[] {
  return all ? ordered : ordered.slice(0, PINNED_FIRST);
}

/** What the Issues page has on screen: the favourites pinned above the list, then the list. */
export type IssuesScreen<T> = {
  /** Favourites in their own group (not while searching or browsing hidden issues). */
  pinnedMode: boolean;
  /** The main list is drawn (not with "favourites only" in pinned mode). */
  showMain: boolean;
  page: number;
  /** Every favourite, in order, and whether "Show all" is on. */
  pinned: T[];
  allPinned: boolean;
  issues: T[];
};

/** The rows j / k walk, in screen order: only rows that are drawn, so Enter never acts on a hidden one. */
export function keyboardRows<T>(s: IssuesScreen<T>): T[] {
  return [...(s.pinnedMode && s.page === 1 ? pinnedDrawn(s.pinned, s.allPinned) : []), ...(s.showMain ? s.issues : [])];
}

/** The header's "N in view": the list's total while it is drawn, plus the favourites pinned above it. */
export function inViewCount(s: { pinnedMode: boolean; showMain: boolean; total: number; pinned: number }): number {
  return (s.showMain ? s.total : 0) + (s.pinnedMode ? s.pinned : 0);
}
