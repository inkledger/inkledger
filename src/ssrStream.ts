import type { ReactNode } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { PassThrough } from "node:stream";

/** The whole HTML of a tree, once every Suspense boundary has resolved. */
export function renderAllReady(node: ReactNode): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    output.on("error", reject);
    // React 19.2 could call onAllReady more than once (concurrent renders sharing a lazy):
    // a second pipe throws, so only the first one pipes.
    let piped = false;
    const { pipe } = renderToPipeableStream(node, {
      onAllReady() {
        if (piped) return;
        piped = true;
        pipe(output);
      },
      onShellError(error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
      onError(error) {
        console.error("[ssr]", error);
      },
    });
  });
}
