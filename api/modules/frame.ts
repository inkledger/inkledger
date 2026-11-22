import { MODULES_RUN_PATH } from "@contracts/modules";

/**
 * A framed module's document: sandboxed (opaque origin: no cookie, storage or
 * DOM of the app), scripts only by nonce or from the module code route, no
 * network at all. Served, not srcdoc: srcdoc would inherit the app's policy.
 */
export const frameCsp = (origin: string, nonce: string) =>
  [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${origin}${MODULES_RUN_PATH}/`,
    "worker-src blob:",
    "img-src blob: data:",
    "media-src blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");

// "<" escaped: nothing in the JSON can close its script element.
const LT = "\\" + "u003c";
const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, LT);

/** The bootstrap: the import map pins the entry to its hash (SRI) before anything imports it. */
export const frameDocument = (entryUrl: string, integrity: string, nonce: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap" nonce="${nonce}">${inlineJson({ imports: {}, integrity: { [entryUrl]: integrity } })}</script>
<script type="module" nonce="${nonce}">parent.postMessage({ type: "ready" }, "*");</script>
</head><body></body></html>
`;
