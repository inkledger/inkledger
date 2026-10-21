/**
 * A finished column (done, cancelled) shows what was finished lately: the
 * cards with activity in the last two weeks, at most `cap`, newest first.
 * The rest wait behind "Show older".
 */
export const RECENT_DAYS = 14;

export function recentFinished<T extends { relevantAt: number | null }>(items: T[], now: number, cap = 20): { shown: T[]; older: number } {
  const since = now - RECENT_DAYS * 86_400_000;
  const recent = items.filter(i => (i.relevantAt ?? 0) >= since).sort((a, b) => (b.relevantAt ?? 0) - (a.relevantAt ?? 0)).slice(0, cap);
  return { shown: recent, older: items.length - recent.length };
}
