/**
 * Whether this browser draws without a usable graphics card: a software
 * renderer (SwiftShader, Microsoft's WARP / Basic Render Driver, llvmpipe), or
 * WebGL refused as too slow. There a WebGL scene or a big animated canvas runs
 * in the browser's shared graphics process and can freeze every tab, so
 * modules are told (ThemeState.softwareRender) and keep to still pictures.
 * Asked once per page. For tests: localStorage "inkledger-render" = "gpu" | "software".
 */
const SOFTWARE = /swiftshader|basic render|\bwarp\b|llvmpipe|softpipe|software/i;
const OVERRIDE = "inkledger-render";

let known: boolean | null = null;

function forced(): boolean | null {
  try {
    const v = localStorage.getItem(OVERRIDE);
    return v === "gpu" ? false : v === "software" ? true : null;
  } catch {
    return null;
  }
}

function detect(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl", { failIfMajorPerformanceCaveat: true });
    // No WebGL, or only a slow one: as good as software.
    if (!gl) return true;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return SOFTWARE.test(renderer);
  } catch {
    return true;
  }
}

export function softwareRender(): boolean {
  const override = forced();
  if (override !== null) return override;
  known ??= detect();
  return known;
}
