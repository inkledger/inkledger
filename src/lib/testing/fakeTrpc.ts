/**
 * A stand-in for the tRPC React client in node tests that draw a component once (renderToString):
 * each query answers the state given for its path ("mails.addinKey"), or loading; mutations and
 * the utils do nothing. Only for tests: the app never imports it.
 */
export type FakeQuery = { data?: unknown; error?: unknown; /** The data is the previous key's, kept while this one loads. */ placeholder?: boolean };

const noop = () => undefined;

function queryResult(state: FakeQuery | undefined) {
  const failed = state?.error !== undefined;
  const has = state !== undefined && "data" in state;
  return {
    data: state?.data,
    error: failed ? state.error : null,
    isError: failed,
    isSuccess: has && !failed,
    isPending: !has && !failed,
    isLoading: !has && !failed,
    isFetching: false,
    isPlaceholderData: has && state.placeholder === true,
    refetch: () => Promise.resolve(),
  };
}

const mutation = { mutate: noop, mutateAsync: () => Promise.resolve(), reset: noop, isPending: false, isError: false, isSuccess: false };

/** Any call, any property: what useUtils() hands back. */
const inert: unknown = new Proxy(noop, { get: () => inert, apply: () => Promise.resolve() });

/** Enough of `window` for a page drawn once in node (vi.stubGlobal("window", fakeWindow())). */
export function fakeWindow() {
  return {
    history: { state: null },
    location: { protocol: "http:", origin: "http://localhost", search: "", pathname: "/" },
    matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
  };
}

export function fakeTrpc(queries: Record<string, FakeQuery>): unknown {
  const at = (path: string[]): unknown =>
    new Proxy(noop, {
      get(_, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "useQuery" || prop === "useSuspenseQuery") return () => queryResult(queries[path.join(".")]);
        if (prop === "useMutation") return () => mutation;
        if (prop === "useUtils" || prop === "useContext") return () => inert;
        return at([...path, prop]);
      },
    });
  return at([]);
}
