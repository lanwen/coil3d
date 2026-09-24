// The schematic wound-cable path per layer (issue #4, docs/research.md §5
// "Wire schematic"). This does NOT model the physical wire as its own solid
// (it is never exported); it is a dense centerline sample the viewer lofts
// into tube geometry, so the wound cable reads as a distinct body in the
// line-art renderer.
//
// Reuses the exact numbers the solver and the wall already computed --
// `LayerResult.offset`/`.turns` (capacity.ts) and the wall's own groove
// `pitch`/`zStart` (wall.ts's `createWallProfile`, shared so layer 1's wire
// sits centered in the printed groove) -- so this can never drift from the
// solved geometry it is meant to illustrate.

import { clamp01 } from "./capacity";
import { createWallProfile, type WallSpec } from "./wall";
import type { LayerResult } from "./types";
import type { WireLayerPath } from "./types";

// Sample density: dense enough that a Catmull-Rom tube built from the points
// looks smooth, but capped so a many-hundred-turn layer doesn't produce an
// unbounded number of samples. A low turn count needs the HIGH end of this
// range, not the low end: with few turns every one of them is individually
// visible (the viewer only drops to a simplified envelope past ~60 turns --
// see src/viewer/wireGeometry.ts), so a coarse per-turn sample count shows up
// directly as a faceted, polygonal turn instead of a smooth ring.
const MIN_SAMPLES_PER_TURN = 3;
const MAX_SAMPLES_PER_TURN = 24;
const MAX_TOTAL_SAMPLES = 6000;

function samplesPerTurn(turns: number): number {
  if (turns <= 0) return MIN_SAMPLES_PER_TURN;
  const perTurn = Math.floor(MAX_TOTAL_SAMPLES / turns);
  return Math.max(MIN_SAMPLES_PER_TURN, Math.min(MAX_SAMPLES_PER_TURN, perTurn));
}

/**
 * Each new layer nests into the valleys of the layer directly below it, an
 * offset of up to half a pitch (docs/research.md §3 "Orthocyclic winding").
 * Nesting into a half-pitch-shifted layer's valleys shifts by another half
 * pitch, so the cumulative shift alternates between 0 and half a pitch
 * (mod 1 pitch) rather than growing layer over layer -- hence `% 2`, not a
 * running total. `quality` (0..1) blends this toward 0 (stacked, no shift)
 * exactly like `radialPitch` blends the radial offset (capacity.ts).
 */
function phaseShiftTurns(layer: number, quality: number): number {
  return ((layer - 1) % 2) * clamp01(quality) * 0.5;
}

/** Build the schematic wire centerline for every wound layer. */
export function buildWirePaths(layerResults: LayerResult[], wallSpec: WallSpec, windingQuality: number): WireLayerPath[] {
  const profile = createWallProfile(wallSpec);
  const { pitch, zStart } = profile;
  const paths: WireLayerPath[] = [];

  for (const { layer, turns, offset } of layerResults) {
    if (turns <= 0) continue;

    const radius = wallSpec.outerRadius + offset;
    const shift = phaseShiftTurns(layer, windingQuality);
    const perTurn = samplesPerTurn(turns);
    const sampleCount = Math.max(2, Math.round(turns * perTurn) + 1);

    const points = new Float32Array(sampleCount * 3);
    for (let i = 0; i < sampleCount; i++) {
      const phi = (turns * i) / (sampleCount - 1) + shift;
      const theta = 2 * Math.PI * phi;
      points[i * 3] = radius * Math.cos(theta);
      points[i * 3 + 1] = radius * Math.sin(theta);
      points[i * 3 + 2] = zStart + pitch * phi;
    }

    paths.push({ layer, turns, points });
  }

  return paths;
}
