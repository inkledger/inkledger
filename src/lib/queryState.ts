/**
 * A query showing its own data: loaded, and not the previous key's kept on screen while this one
 * loads (keepPreviousData). What is worked out from it (holes, exports, copies) waits for this.
 */
export function ownData(query: { data: unknown; isPlaceholderData: boolean }): boolean {
  // Data, not isSuccess: a failed refetch keeps the data read before, still this key's.
  return query.data !== undefined && !query.isPlaceholderData;
}

/**
 * Its own data, and its last read answered: what offers to log time (a hole to fill) waits for
 * this, since time logged elsewhere after an older read would be offered again.
 */
export function freshData(query: { data: unknown; isPlaceholderData: boolean; isError: boolean }): boolean {
  return ownData(query) && !query.isError;
}
