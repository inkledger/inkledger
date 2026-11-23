/** The frames runtime (and zod with it) loads with the first framed module, not with every page. */
let frames: Promise<typeof import("./frames")> | null = null;

export const loadFrames = () => (frames ??= import("./frames"));

/** Runs with the runtime only once some frame loaded it: before that, no runtime is running. */
export function withLoadedFrames(run: (f: typeof import("./frames")) => void) {
  void frames?.then(run);
}
