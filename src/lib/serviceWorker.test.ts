import { describe, expect, it } from "vitest";
import { serviceWorkerUrl } from "./serviceWorker";

describe("the service worker's address", () => {
  // sw.js has the same bytes in every build: under one address the browser never installed a new build's.
  it("names the page's build, so every build installs its own", () => {
    expect(serviceWorkerUrl("b1")).toBe("/sw.js?build=b1");
    expect(serviceWorkerUrl("b1")).not.toBe(serviceWorkerUrl("b2"));
  });

  it("stays plain without a build (development)", () => {
    expect(serviceWorkerUrl(null)).toBe("/sw.js");
  });
});
