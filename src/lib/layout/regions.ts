/**
 * The spatial system's container sizes (docs/design-system.md §7.1), in rem so that density moves them:
 * a block is `s` below `m`, `m` from 28rem, `l` from 56rem, `xl` from 80rem. The same thresholds as a
 * desk pane's (src/components/issue/paneSize.ts) and as tailwind.config.js's `@m`/`@l`/`@xl` variants
 * (checked by regions.test.ts), so a block and a pane agree on what "large" means.
 */
export const REGION_REM = { m: 28, l: 56, xl: 80 } as const;

export type RegionSize = "s" | "m" | "l" | "xl";

/** The size of a block `width` px wide, with the root font at `remPx`. */
export function regionSize(width: number, remPx: number): RegionSize {
  const rem = width / (remPx > 0 ? remPx : 16);
  return rem < REGION_REM.m ? "s" : rem < REGION_REM.l ? "m" : rem < REGION_REM.xl ? "l" : "xl";
}
