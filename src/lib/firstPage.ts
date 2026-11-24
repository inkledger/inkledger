/**
 * The first page's code, asked for by App.tsx as it loads (beside the session check): main.tsx
 * hydrates once it is in, so that page draws at once and the server's markup takes clicks.
 * Settled either way: a chunk that fails is the route's to say.
 */
let pending: Promise<void> = Promise.resolve();

export const firstPage = {
  set(load: Promise<unknown>) {
    pending = load.then(
      () => undefined,
      () => undefined
    );
  },
  loaded: (): Promise<void> => pending,
};
