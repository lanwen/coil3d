import { circumscribedRadius, offsetPerimeter } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { LayerResult } from "./types";

const SQRT3 = Math.sqrt(3);
const MAX_PHASE_SHIFT_TURNS = 0.5;

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function phaseShiftTurns(layer: number, quality: number): number {
  return ((layer - 1) % 2) * clamp01(quality) * MAX_PHASE_SHIFT_TURNS;
}

export function radialPitch(d: number, quality: number): number {
  const ideal = (d * SQRT3) / 2;
  const worst = d;
  const q = clamp01(quality);
  return ideal * q + worst * (1 - q);
}

export interface GeometryInputs {
  outline: ShapeOutline;
  usableHeight: number;
  layers: number;
  wireDiameter: number;
  grooveDepth: number;
  pitch: number;
  quality: number;
}

export interface CapacityResult {
  layerResults: LayerResult[];
  totalWoundLength: number;
  outermostOffset: number;
}

export function turnsForLayer(height: number, pitch: number, layer: number, quality: number): number {
  const usable = layer === 1 ? height : height - clamp01(quality) * pitch * MAX_PHASE_SHIFT_TURNS;
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
    const turns = turnsForLayer(g.usableHeight, pitch, k, g.quality);
    const length = turns * Math.sqrt(perimeter * perimeter + pitch * pitch);
    layerResults.push({ layer: k, turns, offset, perimeter, length });
    totalWoundLength += length;
    lastOffset = offset;
  }

  return { layerResults, totalWoundLength, outermostOffset: lastOffset };
}

export function envelopeDiameter(outline: ShapeOutline, lastLayerOffset: number, wireDiameter: number): number {
  return 2 * circumscribedRadius(outline, lastLayerOffset + wireDiameter / 2);
}
