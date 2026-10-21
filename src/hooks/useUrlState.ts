import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { readFields, writeFields, type Fields } from "@/lib/urlCodecs";

/**
 * Page state kept in the URL (filters, period, search): back/forward and
 * links bring it back exactly. Updates replace the history entry, so typing
 * or toggling never adds steps to Back. Patch several fields in one call.
 */
export function useUrlFields<T>(fields: Fields<T>): [T, (patch: Partial<T>) => void] {
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  // `fields` must be stable (module constant or memoized): fallbacks may
  // depend on today. The URL text is the real input.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `params` is read through `key`
  const value = useMemo(() => readFields(params, fields), [key, fields]);
  const set = useCallback(
    (patch: Partial<T>) => setParams(prev => writeFields(prev, fields, patch), { replace: true }),
    [setParams, fields]
  );
  return [value, set];
}
