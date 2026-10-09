// Forward capacity math: given a FULLY specified geometry (a shape outline,
// height, layers) and a winding-quality scalar, compute turns/layer,
// per-layer lengths and total wound length (docs/design.md, Capacity math).
// Works on any convex ShapeOutline (issue #6, see shapes.ts) through the
// shape registry instead of a per-kind switch.

import { circumscribedRadius, offsetPerimeter } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { LayerResult } from "./types";

const SQRT3 = Math.sqrt(3);

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function phaseShiftTurns(layer: number, quality: number): number {
  return ((layer - 1) % 2) * clamp01(quality) * 0.5;
}

/** h(q): radial pitch between layer centerlines. q=1 -> d*sqrt(3)/2 (ideal orthocyclic), q=0 -> d (stacked). */
export function radialPitch(d: number, quality: number): number {
  const ideal = (d * SQRT3) / 2;
  const worst = d;
  const q = clamp01(quality);
  return ideal * q + worst * (1 - q);
}

export interface GeometryInputs {
  /** The winding surface's outline at offset 0 (docs/design.md, Shapes). */
  outline: ShapeOutline;
  /** USABLE winding height (core height minus top/bottom margins), mm. */
  height: number;
  layers: number;
  wireDiameter: number;
  grooveDepth: number;
  /** Helical pitch, mm (wall.ts's `grooveShape`). */
  pitch: number;
  /** 0..1, see radialPitch. */
  quality: number;
}

export interface CapacityResult {
  layerResults: LayerResult[];
  totalWoundLength: number;
  /** Radial offset of the outermost wire centerline from the core surface. */
  outermostOffset: number;
}

/**
 * Turns-per-layer for layer k (1-indexed): layer 1 fills the usable height
 * with the groove's pitch p. Orthocyclic layers (k>1) nest into the
 * valleys of the layer below, offset by up to half a pitch (APPROX,
 * continuous in quality so the solver stays monotonic; see
 * docs/design.md, Capacity math).
 */
export function turnsForLayer(height: number, pitch: number, layer: number, quality: number): number {
  const usable = layer === 1 ? height : height - clamp01(quality) * (pitch / 2);
  return Math.max(0, Math.floor(usable / pitch));
}

export function computeCapacity(g: GeometryInputs): CapacityResult {
  const { pitch } = g;
  const h = radialPitch(g.wireDiameter, g.quality);
  const o1 = g.wireDiameter / 2 - g.grooveDepth;

  const layerResults: LayerResult[] = [];
  let totalWoundLength = 0;
  let lastOffset = o1;

  for (let k = 1; k <= g.layers; k++) {
    const offset = o1 + (k - 1) * h;
    const perimeter = offsetPerimeter(g.outline, offset);
    const turns = turnsForLayer(g.height, pitch, k, g.quality);
    // Helix length correction per turn: sqrt(perimeter^2 + pitch^2) (docs/design.md, Capacity math).
    const length = turns * Math.sqrt(perimeter * perimeter + pitch * pitch);
    layerResults.push({ layer: k, turns, offset, perimeter, length });
    totalWoundLength += length;
    lastOffset = offset;
  }

  return { layerResults, totalWoundLength, outermostOffset: lastOffset };
}

/** Footprint diameter at the outside of the outermost wound wire -- the
 * outline's own TRUE circumscribed extent at that offset, not a bounding
 * circle across a sharp corner (docs/design.md, Shapes; shapes.ts). */
export function envelopeDiameter(outline: ShapeOutline, lastLayerOffset: number, wireDiameter: number): number {
  return 2 * circumscribedRadius(outline, lastLayerOffset + wireDiameter / 2);
}
