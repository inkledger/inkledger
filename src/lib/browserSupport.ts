import type { StoreRequirement } from "@contracts/store";

let webgl2: boolean | null = null;

/** WebGL2 with float render targets (what the GPU-drawn modules need); checked once. */
function hasWebGL2(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    webgl2 = !!gl && !!gl.getExtension("EXT_color_buffer_float");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

const CHECKS: Record<StoreRequirement, () => boolean> = { webgl2: hasWebGL2 };

/** The requirements this browser does not meet. */
export const missingRequirements = (requires: readonly StoreRequirement[] | undefined): StoreRequirement[] =>
  (requires ?? []).filter(r => !CHECKS[r]());
