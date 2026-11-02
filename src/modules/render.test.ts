import { afterEach, describe, expect, it, vi } from "vitest";

/** A page whose WebGL names this renderer (null: no WebGL, or refused as too slow). */
function page(renderer: string | null, stored: string | null = null) {
  const gl = renderer === null
    ? null
    : {
        getExtension: (name: string) => (name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : name === "WEBGL_lose_context" ? { loseContext: () => undefined } : null),
        getParameter: () => renderer,
      };
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => gl }) });
  vi.stubGlobal("localStorage", { getItem: () => stored });
}

async function softwareRender() {
  vi.resetModules();
  return (await import("./render")).softwareRender();
}

describe("softwareRender", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a real graphics card is not software", async () => {
    page("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)");
    expect(await softwareRender()).toBe(false);
  });

  it("Windows without a usable GPU (WARP / Basic Render Driver), SwiftShader and llvmpipe are", async () => {
    for (const r of [
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
    ]) {
      page(r);
      expect(await softwareRender(), r).toBe(true);
    }
  });

  it("no WebGL, or WebGL refused as too slow, counts as software", async () => {
    page(null);
    expect(await softwareRender()).toBe(true);
  });

  it("a test can say which", async () => {
    page("SwiftShader", "gpu");
    expect(await softwareRender()).toBe(false);
    page("NVIDIA GeForce", "software");
    expect(await softwareRender()).toBe(true);
  });
});
