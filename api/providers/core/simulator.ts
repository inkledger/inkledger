// What every HTTP simulator (tests) reads of a request before answering it.

/** A request as a simulator reads it: its address, its method in capitals, its headers. */
export function simRequest(input: string | URL | Request, init?: RequestInit): { url: URL; method: string; headers: Headers } {
  return { url: new URL(String(input instanceof Request ? input.url : input)), method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers) };
}
