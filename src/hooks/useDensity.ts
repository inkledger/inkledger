import { deviceSetting } from "@/lib/storage";

export type Density = "compact" | "comfortable";

const density = deviceSetting<Density>("ikl-density", raw => (raw === "comfortable" ? "comfortable" : "compact"));

/** UI density (per device): "compact" zooms the whole app out to ~88%. */
export function useDensity(): [Density, (d: Density) => void] {
  const set = (d: Density) => {
    density.set(d);
    document.documentElement.dataset.density = d;
  };
  return [density.use(), set];
}
