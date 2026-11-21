/**
 * A query showing its own data: loaded, and not the previous key's kept on screen while this one
 * loads (keepPreviousData). What is worked out from it (holes, exports, copies) waits for this.
 */
export function ownData(query: { isSuccess: boolean; isPlaceholderData: boolean }): boolean {
  return query.isSuccess && !query.isPlaceholderData;
}
