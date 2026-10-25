import { FLAT_GAP_CLEARANCE } from "./constants";
import { circumscribedRadius, offsetPerimeter, spiralTurnLength } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { LayerResult } from "./types";

const SQRT3 = Math.sqrt(3);
const MAX_PHASE_SHIFT_TURNS = 0.5;

function clamp01(x: number): number {
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

const MIN_TURNS_TO_NEST = 2;

export function flatGap(wireDiameter: number): number {
  return wireDiameter + FLAT_GAP_CLEARANCE;
}

export function flatCableZ(wireDiameter: number): number {
  return flatGap(wireDiameter) / 2;
}

export function effectiveQuality(usableHeight: number, pitch: number, quality: number): number {
  return Math.floor(usableHeight / pitch) < MIN_TURNS_TO_NEST ? 0 : clamp01(quality);
}

interface GeometryInputs {
  outline: ShapeOutline;
  usableHeight: number;
  layers: number;
  wireDiameter: number;
  grooveDepth: number;
  pitch: number;
  quality: number;
  flatFits: boolean;
}

export interface CapacityResult {
  layerResults: LayerResult[];
  totalWoundLength: number;
  outermostOffset: number;
  windingQualityUsed: number;
  flat: boolean;
}

export function turnsForLayer(height: number, pitch: number, layer: number, quality: number): number {
  const usable = layer === 1 ? height : height - clamp01(quality) * pitch * MAX_PHASE_SHIFT_TURNS;
  return Math.max(0, Math.floor(usable / pitch));
}

export function computeCapacity(g: GeometryInputs): CapacityResult {
  const { pitch } = g;
  const quality = effectiveQuality(g.usableHeight, pitch, g.quality);
  const flat = g.flatFits && Math.floor(g.usableHeight / pitch) < MIN_TURNS_TO_NEST;
  const h = radialPitch(g.wireDiameter, quality);
  const o1 = g.wireDiameter / 2 - g.grooveDepth;

  const layerResults: LayerResult[] = [];
  let totalWoundLength = 0;
  let lastOffset = o1;

  for (let k = 1; k <= g.layers; k++) {
    const offset = o1 + (k - 1) * h;
    const perimeter = offsetPerimeter(g.outline, offset);
    const turns = flat ? 1 : turnsForLayer(g.usableHeight, pitch, k, quality);
    const length = flat ? spiralTurnLength(g.outline, offset, h) : turns * Math.sqrt(perimeter * perimeter + pitch * pitch);
    layerResults.push({ layer: k, turns, offset, perimeter, length });
    totalWoundLength += length;
    if (turns > 0) lastOffset = offset;
  }

  return { layerResults, totalWoundLength, outermostOffset: lastOffset, windingQualityUsed: quality, flat };
}

export function envelopeDiameter(outline: ShapeOutline, lastLayerOffset: number, wireDiameter: number): number {
  return 2 * circumscribedRadius(outline, lastLayerOffset + wireDiameter / 2);
}
