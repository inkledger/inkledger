import type { EvidenceSet, FlowMapView } from "@contracts/workspace/flowMap";
import type { ResolvedPlacement } from "@contracts/workspace/model";

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const short = (value: string) => value.length > 52 ? `${value.slice(0, 49)}...` : value;
const text = (x: number, y: number, value: string, size = 13, fill = "#172033") => `<text x="${x}" y="${y}" font-family="system-ui,sans-serif" font-size="${size}" fill="${fill}">${escape(value)}</text>`;

export function renderFlowMapSvg(evidence: EvidenceSet, placements: readonly ResolvedPlacement[], view: FlowMapView): string {
  const rows: { label: string; value: string; ratio: number; cells?: number[][]; placement?: ResolvedPlacement }[] = view === "heat"
    ? evidence.heat.map(point => ({
      id: point.controlId,
      placement: placements.find(item => item.anchorId === point.anchorId),
      label: point.controlId,
      value: `${point.activations} activations · ${(point.activationRate * 100).toFixed(1)}% of exposures · ${point.failures} failed`,
      ratio: Math.min(1, point.activations / Math.max(1, ...evidence.heat.map(item => item.activations))),
      cells: point.cells,
    }))
    : view === "flow"
      ? evidence.flows.map(edge => ({ label: `${edge.fromControlId} → ${edge.toControlId}`, value: `${edge.count} transitions`, ratio: edge.count / Math.max(1, ...evidence.flows.map(item => item.count)) }))
      : view === "friction"
        ? evidence.friction.map(point => ({ label: point.controlId, value: `${point.abandoned} abandoned · ${point.failures} failed · ${point.backtracks} backtracks · ${point.loops} loops`, ratio: (point.abandoned + point.failures + point.backtracks + point.loops) / Math.max(1, ...evidence.friction.map(item => item.abandoned + item.failures + item.backtracks + item.loops)) }))
        : evidence.expectations.map(gap => ({ label: `${gap.pattern}: ${gap.areaId}${gap.destinationControlId ? ` → ${gap.destinationControlId}` : ""}`, value: `${gap.occurrences} observed · confidence ${(gap.confidence * 100).toFixed(0)}% · ${gap.state}`, ratio: gap.confidence }));
  const height = Math.max(230, 142 + rows.length * 66);
  const body = rows.map((row, index) => {
    const y = 110 + index * 66;
    const cells = row.cells?.flatMap((column, yIndex) => column.map((count, xIndex) => count ? `<rect x="${590 + xIndex * 15}" y="${y - 26 + yIndex * 4}" width="12" height="3" rx="1" fill="#4f46e5" opacity="${Math.min(1, 0.2 + count / Math.max(1, ...column))}"><title>${count} pointer activations</title></rect>` : "")).join("") ?? "";
    return `<g>${text(30, y - 10, short(row.label), 13)}${text(30, y + 11, short(row.value), 11, "#526078")}<rect x="30" y="${y + 22}" width="520" height="8" rx="4" fill="#e7ebf3"/><rect x="30" y="${y + 22}" width="${Math.max(2, 520 * Math.min(1, row.ratio))}" height="8" rx="4" fill="${view === "friction" ? "#c2410c" : "#4f46e5"}"/>${cells}${row.placement ? `<title>Area: ${escape(row.placement.areaId)}</title>` : ""}</g>`;
  }).join("");
  const empty = rows.length === 0 ? text(30, 145, "No evidence for this view. Coverage gaps are reported above.", 14, "#526078") : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}" role="img" aria-labelledby="flow-title flow-description"><title id="flow-title">FlowMap: ${view}</title><desc id="flow-description">Schematic, aggregated interactions by catalog identifier. Not visual attention tracking. ${evidence.coverage.gaps} collection gaps.</desc><rect width="900" height="${height}" fill="#ffffff"/>${text(30, 36, `FlowMap / ${view}`, 22)}${text(30, 61, `${evidence.scope.surfaceId} · ${evidence.scope.deviceClass} · ${evidence.descriptor.effectiveRevision}`, 11, "#526078")}${text(30, 85, `${evidence.coverage.activeDays} active days · ${evidence.coverage.exposures} exposures · ${evidence.coverage.gaps} gaps · ${evidence.origin}`, 12, "#526078")}${body}${empty}</svg>`;
}
