import { t } from "@/i18n";

/**
 * Data colours per project: six tone-on-tone tones (--project-1..6, derived
 * from the theme base), picked by a hash of the project key so a project
 * keeps its colour across periods and pages.
 */
// `solid`: the soft tone made opaque over a card (index.css), for surfaces
// that stand in a module's light: no shadow shows through them.
const TONES = [
  { fill: "bg-project-1", soft: "bg-project-1/40", solid: "bg-project-1-solid", stroke: "hsl(var(--project-1))" },
  { fill: "bg-project-2", soft: "bg-project-2/40", solid: "bg-project-2-solid", stroke: "hsl(var(--project-2))" },
  { fill: "bg-project-3", soft: "bg-project-3/40", solid: "bg-project-3-solid", stroke: "hsl(var(--project-3))" },
  { fill: "bg-project-4", soft: "bg-project-4/40", solid: "bg-project-4-solid", stroke: "hsl(var(--project-4))" },
  { fill: "bg-project-5", soft: "bg-project-5/40", solid: "bg-project-5-solid", stroke: "hsl(var(--project-5))" },
  { fill: "bg-project-6", soft: "bg-project-6/40", solid: "bg-project-6-solid", stroke: "hsl(var(--project-6))" },
] as const;

/** Legend swatch of the projects grouped as "Other". */
const REST = {
  fill: "bg-muted-foreground/25",
  soft: "bg-muted-foreground/10",
  solid: "bg-rest-solid",
  stroke: "hsl(var(--muted-foreground) / 0.25)",
};

/** Projects named in the legend; the rest is summed as "Other". */
const LEGEND_SIZE = 5;

export type ProjectColor = { fill: string; soft: string; solid: string; stroke: string };

/** Project of an issue key ("PRJ-12" → "PRJ"). */
export function projectOf(issueKey: string): string {
  return issueKey.split("-")[0] ?? issueKey;
}

/** FNV-1a: small, stable, well spread over short keys. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable colour of a project key, the same on every page and period. */
export function projectColor(project: string): ProjectColor {
  return TONES[hash(project) % TONES.length];
}

/** Projects ordered by seconds: the legend (top ones + "Other") and their count. */
export function rankProjects(totals: Map<string, number>): {
  colorOf: (project: string) => ProjectColor;
  legend: { project: string; seconds: number; color: ProjectColor }[];
  count: number;
} {
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const legend = ordered.slice(0, LEGEND_SIZE).map(([project, seconds]) => ({
    project,
    seconds,
    color: projectColor(project),
  }));
  const rest = ordered.slice(LEGEND_SIZE).reduce((a, [, s]) => a + s, 0);
  if (rest > 0) legend.push({ project: t("pages.dashboard.otherProjects"), seconds: rest, color: REST });
  return { colorOf: projectColor, legend, count: ordered.length };
}
