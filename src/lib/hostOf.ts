/** The host of a link, or null when it is no URL ("https://", "http://a b": trackers store such links). */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
