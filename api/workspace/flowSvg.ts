import type { EvidenceSet, FlowMapView } from "@contracts/workspace/flowMap";
import type { ResolvedPlacement } from "@contracts/workspace/model";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { blocksIn, dashboardSegments, heatLayerOf, hitStep, sidebarActionSegments, sketchFor, HIT_GRID_SIZE, type HeatLayer, type Sketch, type SketchArea } from "@contracts/workspace/sketch";
import { t, type MessageKey } from "@contracts/i18n";

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
// The picture is shown and shared: controls, areas and the period by name, never by internal id.
const controlName = (controlId: string) => {
  const control = CATALOG_V1.controls.find(item => item.id === controlId);
  return control ? t(control.accessibility.labelKey as MessageKey, { provider: t("common.tracker") }) : controlId;
};
const anchorName = (anchorId: string) => {
  const anchor = CATALOG_V1.anchors.find(item => item.id === anchorId);
  return anchor ? t(anchor.accessibility.labelKey as MessageKey, { provider: t("common.tracker") }) : anchorId;
};
const areaName = (areaId: string) => t(`settings.categories.workspace.areaNames.${areaId.replace(/[.-]/g, "_")}` as MessageKey);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const short = (value: string) => value.length > 52 ? `${value.slice(0, 49)}...` : value;
const text = (x: number, y: number, value: string, size = 13, fill = "#172033") => `<text x="${x}" y="${y}" font-family="system-ui,sans-serif" font-size="${size}" fill="${fill}">${escape(value)}</text>`;

export function renderFlowMapSvg(evidence: EvidenceSet, placements: readonly ResolvedPlacement[], view: FlowMapView): string {
  if (view === "heat") {
    const sketch = sketchFor(evidence.scope);
    // A layout this version can't draw (none given, or none of its blocks on this page): the list below.
    if (sketch && layoutOf(sketch, placements).length > 0) return renderHeatLayout(evidence, placements, sketch);
  }
  const rows: { label: string; value: string; ratio: number }[] = view === "heat"
    ? evidence.heat.map(point => ({
      label: controlName(point.controlId),
      value: `${point.activations} activations · ${(point.activationRate * 100).toFixed(1)}% of exposures · ${point.failures} failed`,
      ratio: Math.min(1, point.activations / Math.max(1, ...evidence.heat.map(item => item.activations))),
    }))
    : view === "flow"
      ? evidence.flows.map(edge => ({ label: `${controlName(edge.fromControlId)} → ${controlName(edge.toControlId)}`, value: `${edge.count} transitions`, ratio: edge.count / Math.max(1, ...evidence.flows.map(item => item.count)) }))
      : view === "friction"
        ? evidence.friction.map(point => ({ label: controlName(point.controlId), value: `${point.abandoned} abandoned · ${point.failures} failed · ${point.backtracks} backtracks · ${point.loops} loops`, ratio: (point.abandoned + point.failures + point.backtracks + point.loops) / Math.max(1, ...evidence.friction.map(item => item.abandoned + item.failures + item.backtracks + item.loops)) }))
        : evidence.expectations.map(gap => ({ label: `${gap.pattern}: ${areaName(gap.areaId)}${gap.destinationControlId ? ` → ${controlName(gap.destinationControlId)}` : ""}`, value: `${gap.occurrences} observed · confidence ${(gap.confidence * 100).toFixed(0)}% · ${gap.state}`, ratio: gap.confidence }));
  const height = Math.max(230, 142 + rows.length * 66);
  const body = rows.map((row, index) => {
    const y = 110 + index * 66;
    return `<g>${text(30, y - 10, short(row.label), 13)}${text(30, y + 11, short(row.value), 11, "#526078")}<rect x="30" y="${y + 22}" width="520" height="8" rx="4" fill="#e7ebf3"/><rect x="30" y="${y + 22}" width="${Math.max(2, 520 * Math.min(1, row.ratio))}" height="8" rx="4" fill="${view === "friction" ? "#c2410c" : "#4f46e5"}"/></g>`;
  }).join("");
  const empty = rows.length === 0 ? text(30, 145, "No evidence for this view. Coverage gaps are reported above.", 14, "#526078") : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}" role="img" aria-labelledby="flow-title flow-description"><title id="flow-title">FlowMap: ${view}</title><desc id="flow-description">Schematic, aggregated interactions per control. Not visual attention tracking. ${evidence.coverage.gaps} collection gaps.</desc><rect width="900" height="${height}" fill="#ffffff"/>${text(30, 36, `FlowMap / ${view}`, 22)}${text(30, 61, `${evidence.scope.surfaceId} · ${evidence.scope.deviceClass} · ${day(evidence.coverage.firstAt)} – ${day(evidence.coverage.lastAt)}`, 11, "#526078")}${text(30, 85, `${evidence.coverage.activeDays} active days · ${evidence.coverage.exposures} exposures · ${evidence.coverage.gaps} gaps · ${evidence.origin}`, 12, "#526078")}${body}${empty}</svg>`;
}

// ─── The heat view: the page itself, with its use over each block ──────────────────────────────────

/**
 * A fixed palette, light paper: a file is opened anywhere, never in the app's theme. Warm neutrals and
 * four steps of one terracotta for use, like the app's default theme.
 */
const PAPER = { ground: "#fbf8f4", frame: "#f3eee8", block: "#ffffff", line: "#ddd3c9", ink: "#2b2420", muted: "#776a61", dot: "#8a3a1c" } as const;
const HEAT_FILLS = ["#f6dccf", "#efc0a8", "#e5a080", "#d98058"] as const;
const heatFill = (count: number, most: number) => count <= 0 ? PAPER.block : HEAT_FILLS[Math.min(HEAT_FILLS.length - 1, Math.floor((count / Math.max(1, most)) * HEAT_FILLS.length))];

/** How the page lays its blocks out, as a tree the drawing measures: the same composition the app draws (PageSketch). */
type Box =
  | { kind: "block"; anchorId: string }
  | { kind: "row"; children: Box[]; weights?: number[] }
  | { kind: "column"; children: Box[] }
  | { kind: "tiles"; children: Box[] }
  | { kind: "area"; areaId: string; child: Box };

const GAP = 8;
const BLOCK_H = 64;
const AREA_HEAD = 20;
const AREA_PAD = 8;
const TILE_COLUMNS = 3;

function layoutOf(sketch: Sketch, placements: readonly ResolvedPlacement[]): Box[] {
  const shown = (areaId: string) => blocksIn(placements, areaId).filter(placement => placement.visible).map(placement => placement.anchorId);
  const block = (anchorId: string): Box => ({ kind: "block", anchorId });
  const nestedArea = (areaId: string) => {
    const area = sketch.areas.find(item => item.areaId === areaId && item.region === "nested");
    return area ? areaBox(area) : null;
  };
  function areaBox(area: SketchArea): Box | null {
    const ids = shown(area.areaId);
    let child: Box | null = null;
    if (area.axis === "flow") {
      const { lead, segments } = dashboardSegments(ids);
      // The secondary area is a band above the timeline (as on the page).
      const top = nestedArea("dashboard.secondary");
      const wide = sketch.frame === "page";
      const parts: Box[] = [];
      if (top) parts.push(top);
      if (lead) parts.push(block(lead));
      for (const segment of segments) {
        if (segment.kind === "band") { parts.push(block(segment.anchorId)); continue; }
        const children = segment.items.map((item): Box => typeof item === "string" ? block(item) : { kind: "column", children: item.map(block) });
        const paired = wide && segment.items.includes("dashboard.summary") && segment.items.some(item => typeof item !== "string");
        parts.push(wide ? { kind: "row", children, ...(paired ? { weights: [0.8, 1.45] } : {}) } : { kind: "column", children });
      }
      child = parts.length > 0 ? { kind: "column", children: parts } : null;
    } else if (area.areaId === "shell.actions") {
      const { before, after } = sidebarActionSegments(ids, ids.indexOf("shell.quick-start"));
      const timer = nestedArea("shell.timer");
      const children = [...before.map(block), ...(timer ? [timer] : []), ...after.map(block)];
      child = children.length > 0 ? { kind: "column", children } : null;
    } else if (ids.length > 0) {
      child = { kind: area.axis === "row" ? "row" : area.axis === "tiles" ? "tiles" : "column", children: ids.map(block) };
    }
    return child ? { kind: "area", areaId: area.areaId, child } : null;
  }
  return sketch.areas.filter(area => area.region !== "tray" && area.region !== "nested").flatMap(area => {
    const box = areaBox(area);
    return box ? [box] : [];
  });
}

const widths = (total: number, weights: readonly number[]) => {
  const sum = weights.reduce((a, b) => a + b, 0);
  const free = total - GAP * (weights.length - 1);
  return weights.map(weight => (free * weight) / sum);
};
const weightsOf = (box: Extract<Box, { kind: "row" }>) => box.weights ?? box.children.map(() => 1);

function heightOf(box: Box, width: number): number {
  switch (box.kind) {
    case "block": return BLOCK_H;
    case "area": return AREA_HEAD + AREA_PAD * 2 + heightOf(box.child, width - AREA_PAD * 2);
    case "column": return box.children.reduce((sum, child) => sum + heightOf(child, width), 0) + GAP * Math.max(0, box.children.length - 1);
    case "row": {
      const each = widths(width, weightsOf(box));
      return Math.max(0, ...box.children.map((child, index) => heightOf(child, each[index])));
    }
    case "tiles": {
      const lines = Math.ceil(box.children.length / TILE_COLUMNS);
      return lines * BLOCK_H + GAP * Math.max(0, lines - 1);
    }
  }
}

/** One block: its surface tinted by use, the dots of where it was clicked, its name and its count. */
function drawBlock(anchorId: string, x: number, y: number, width: number, layer: HeatLayer): string {
  const count = layer.uses.get(anchorId) ?? 0;
  const name = anchorName(anchorId);
  const room = Math.max(4, Math.floor((width - (count > 0 ? 64 : 16)) / 6.4));
  const label = name.length > room ? `${name.slice(0, room - 1)}…` : name;
  const uses = t("settings.categories.workspace.timelineUses", { count });
  const grid = layer.grids.get(anchorId);
  const dots: string[] = [];
  if (count > 0 && grid) {
    const left = x + 8;
    const top = y + 24;
    const cellW = (width - 16) / HIT_GRID_SIZE;
    const cellH = (BLOCK_H - 30) / HIT_GRID_SIZE;
    grid.forEach((row, cy) => row.forEach((hits, cx) => {
      const step = hitStep(hits, layer.hitMost);
      if (step === 0) return;
      dots.push(`<circle class="hit" cx="${(left + cellW * (cx + 0.5)).toFixed(1)}" cy="${(top + cellH * (cy + 0.5)).toFixed(1)}" r="${[0, 1.4, 2, 2.6][step]}" fill="${PAPER.dot}" opacity="${[0, 0.5, 0.75, 1][step]}"/>`);
    }));
  }
  return `<g><title>${escape(count > 0 ? `${name}: ${uses}` : name)}</title>`
    + `<rect class="block" x="${x}" y="${y}" width="${width.toFixed(1)}" height="${BLOCK_H}" rx="6" fill="${heatFill(count, layer.most)}" stroke="${PAPER.line}"/>`
    + dots.join("")
    + text(x + 8, y + 16, label, 11, PAPER.ink)
    + (count > 0 ? `<text x="${(x + width - 8).toFixed(1)}" y="${y + 16}" text-anchor="end" font-family="system-ui,sans-serif" font-size="10" fill="${PAPER.ink}">${escape(uses)}</text>` : "")
    + `</g>`;
}

function drawBox(box: Box, x: number, y: number, width: number, layer: HeatLayer): string {
  switch (box.kind) {
    case "block": return drawBlock(box.anchorId, x, y, width, layer);
    case "area": {
      const height = heightOf(box, width);
      return `<rect class="area" x="${x}" y="${y}" width="${width.toFixed(1)}" height="${height}" rx="8" fill="none" stroke="${PAPER.line}" stroke-dasharray="3 3"/>`
        + text(x + AREA_PAD, y + 15, areaName(box.areaId), 10, PAPER.muted)
        + drawBox(box.child, x + AREA_PAD, y + AREA_HEAD + AREA_PAD, width - AREA_PAD * 2, layer);
    }
    case "column": {
      let top = y;
      return box.children.map(child => {
        const drawn = drawBox(child, x, top, width, layer);
        top += heightOf(child, width) + GAP;
        return drawn;
      }).join("");
    }
    case "row": {
      const each = widths(width, weightsOf(box));
      let left = x;
      return box.children.map((child, index) => {
        const drawn = drawBox(child, left, y, each[index], layer);
        left += each[index] + GAP;
        return drawn;
      }).join("");
    }
    case "tiles": {
      const each = widths(width, Array.from({ length: TILE_COLUMNS }, () => 1))[0];
      return box.children.map((child, index) => drawBox(child, x + (index % TILE_COLUMNS) * (each + GAP), y + Math.floor(index / TILE_COLUMNS) * (BLOCK_H + GAP), each, layer)).join("");
    }
  }
}

/** The heat view: the page as laid out, each block tinted by its use, with dots where it was clicked. */
function renderHeatLayout(evidence: EvidenceSet, placements: readonly ResolvedPlacement[], sketch: Sketch): string {
  const width = 900;
  const margin = 32;
  const layer = heatLayerOf(evidence.heat);
  const frameWidth = sketch.frame === "page" ? width - margin * 2 : 400;
  const frameX = sketch.frame === "page" ? margin : (width - frameWidth) / 2;
  const inner = frameWidth - 24;
  const areas = layoutOf(sketch, placements);
  const areasHeight = areas.reduce((sum, box) => sum + heightOf(box, inner), 0) + GAP * Math.max(0, areas.length - 1);
  const frameY = 104;
  const frameHeight = areasHeight + 24;
  let top = frameY + 12;
  const drawn = areas.map(box => {
    const svg = drawBox(box, frameX + 12, top, inner, layer);
    top += heightOf(box, inner) + GAP;
    return svg;
  }).join("");
  const footY = frameY + frameHeight + 30;
  const legend = layer.total === 0
    ? text(margin, footY, t("settings.categories.workspace.useNone"), 12, PAPER.muted)
    : text(margin, footY, t("settings.categories.workspace.heatFew"), 11, PAPER.muted)
      + HEAT_FILLS.map((fill, index) => `<rect x="${margin + 34 + index * 22}" y="${footY - 9}" width="18" height="10" rx="2" fill="${fill}"/>`).join("")
      + text(margin + 34 + HEAT_FILLS.length * 22 + 4, footY, t("settings.categories.workspace.heatMany"), 11, PAPER.muted)
      + `<circle cx="${margin + 220}" cy="${footY - 4}" r="2.6" fill="${PAPER.dot}"/>`
      + text(margin + 228, footY, t("settings.categories.workspace.heatDots"), 11, PAPER.muted);
  const height = footY + 28;
  const period = `${day(evidence.coverage.firstAt)} – ${day(evidence.coverage.lastAt)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="flow-title flow-description">`
    + `<title id="flow-title">FlowMap: heat</title><desc id="flow-description">The page as laid out, each block tinted by how much it was used, with dots where in it the clicks landed. Aggregated, not visual attention tracking. ${evidence.coverage.gaps} collection gaps.</desc>`
    + `<rect width="${width}" height="${height}" fill="${PAPER.ground}"/>`
    + text(margin, 40, "FlowMap / heat", 22, PAPER.ink)
    + text(margin, 64, `${evidence.scope.surfaceId} · ${evidence.scope.deviceClass} · ${period}`, 12, PAPER.muted)
    + text(margin, 84, `${evidence.coverage.activeDays} active days · ${t("settings.categories.workspace.timelineUses", { count: layer.total })} · ${evidence.coverage.gaps} gaps · ${evidence.origin}`, 12, PAPER.muted)
    + `<rect x="${frameX}" y="${frameY}" width="${frameWidth}" height="${frameHeight}" rx="12" fill="${PAPER.frame}" stroke="${PAPER.line}"/>`
    + drawn
    + legend
    + `</svg>`;
}
