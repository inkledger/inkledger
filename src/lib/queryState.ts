/**
 * A query showing its own data: loaded, and not the previous key's kept on screen while this one
 * loads (keepPreviousData). What is worked out from it (holes, exports, copies) waits for this.
 */
export function ownData(query: { data: unknown; isPlaceholderData: boolean }): boolean {
  // Data, not isSuccess: a failed refetch keeps the data read before, still this key's.
  return query.data !== undefined && !query.isPlaceholderData;
}
