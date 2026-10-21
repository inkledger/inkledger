/**
 * A page's code that never arrived (a redeploy replaced its file, the network
 * dropped): React.lazy keeps that failure, so only a reload fetches it again.
 * The texts are the browsers' own (Chrome, Firefox, Safari) and Vite's.
 */
export function isChunkLoadError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i.test(text);
}
