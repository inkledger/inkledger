import { useEffect } from "react";

let base = "inkledger";
let live = "";
const apply = () => {
  document.title = live ? `${live} · ${base}` : base;
};

/** Sets the browser tab title for the current page. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    base = title ? `${title} · inkledger` : "inkledger";
    apply();
  }, [title]);
}

/** Live prefix shared by every page (e.g. the running timer). */
export function setLiveTitle(prefix: string) {
  if (prefix === live) return;
  live = prefix;
  apply();
}
