// The schematic wound-cable path per layer (issue #4, docs/research.md §5
// "Wire schematic"). This does NOT model the physical wire as its own solid
// (it is never exported); it is a dense centerline sample the viewer lofts
// into tube geometry, so the wound cable reads as a distinct body in the
// line-art renderer.
//
// Reuses the exact numbers the solver and the wall already computed --
// `LayerResult.offset`/`.turns`/`.perimeter` (capacity.ts) and the wall's own
// groove `pitch`/`zStart` (wall.ts's `createWallProfile`, shared so layer 1's
// wire sits centered in the printed groove) -- so this can never drift from
// the solved geometry it is meant to illustrate. The (x, y) position at each
// sample comes from `shapes.ts`'s `pointAt(outline, t, offset)`, the same
// arc-length-parameterised outline function the wall's own helix and the
// STEP B-spline fit both sample, so a rounded-square or rounded-triangle
// core's wire follows the real offset outline, not a circle.

import {
  DRAFT_WIRE_MAX_ARC_LENGTH,
  DRAFT_WIRE_MIN_SAMPLES_PER_TURN,
  FINAL_WIRE_MAX_ARC_LENGTH,
  FINAL_WIRE_MIN_SAMPLES_PER_TURN,
} from "./constants";
import { clamp01 } from "./capacity";
import type { XY } from "./innerEnd";
import { pointAt } from "./shapes";
import { createWallProfile, type WallSpec } from "./wall";
import type { LayerResult, Resolution } from "./types";
import type { WireLayerPath } from "./types";

// A hard safety backstop on total samples per layer, so a pathological input
// (well outside the solver's practical bounds) can't allocate unbounded
// memory: if the arc-length target would exceed it, density is scaled back
// (never below MIN_SAMPLES_PER_TURN_FLOOR) rather than sampling that densely.
// Realistic designs never get close to this (a few hundred turns at 96+
// samples/turn is a few tens of thousands of samples).
const MAX_TOTAL_SAMPLES_PER_LAYER = 300_000;
const MIN_SAMPLES_PER_TURN_FLOOR = 8;

/**
 * Samples per turn for the given per-turn helix length (arc length of one
 * full wound turn, `sqrt(perimeter^2 + pitch^2)`): at least `minPerTurn`
 * (so even a tiny turn is smooth), and enough to keep consecutive samples
 * at most `maxArcLength` mm apart along the curve (so a big, slow-curving
 * turn -- a large square or triangle core -- still gets a dense sample
 * along its straight sides, not just its corners).
 */
function samplesPerTurn(helixLength: number, minPerTurn: number, maxArcLength: number): number {
  return Math.max(minPerTurn, Math.ceil(helixLength / maxArcLength));
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

/**
 * Build the schematic wire centerline for every wound layer.
 *
 * `resolution` (issue #7) gates sample density exactly like the mesh's own
 * draft/final column counts: "draft" is cheap enough to stay responsive
 * while the user is still dragging a slider, "final" is dense enough for a
 * smooth on-screen tube (the wire path is never exported, so there is no
 * third, even-denser "for export" tier the way the mesh has one for STL/STEP).
 */
export function buildWirePaths(layerResults: LayerResult[], wallSpec: WallSpec, windingQuality: number, resolution: Resolution): WireLayerPath[] {
  const profile = createWallProfile(wallSpec);
  const { pitch, zStart } = profile;
  const { outline } = wallSpec;
  const [minPerTurn, maxArcLength] =
    resolution === "draft" ? [DRAFT_WIRE_MIN_SAMPLES_PER_TURN, DRAFT_WIRE_MAX_ARC_LENGTH] : [FINAL_WIRE_MIN_SAMPLES_PER_TURN, FINAL_WIRE_MAX_ARC_LENGTH];
  const paths: WireLayerPath[] = [];

  for (const { layer, turns, offset, perimeter } of layerResults) {
    if (turns <= 0) continue;

    const helixLength = Math.hypot(perimeter, pitch);
    let perTurn = samplesPerTurn(helixLength, minPerTurn, maxArcLength);
    if (turns * perTurn > MAX_TOTAL_SAMPLES_PER_LAYER) {
      perTurn = Math.max(MIN_SAMPLES_PER_TURN_FLOOR, Math.floor(MAX_TOTAL_SAMPLES_PER_LAYER / turns));
    }

    const shift = phaseShiftTurns(layer, windingQuality);
    const sampleCount = Math.max(2, Math.round(turns * perTurn) + 1);

    const points = new Float32Array(sampleCount * 3);
    for (let i = 0; i < sampleCount; i++) {
      const phi = (turns * i) / (sampleCount - 1) + shift;
      const p = pointAt(outline, phi, offset);
      points[i * 3] = p.x;
      points[i * 3 + 1] = p.y;
      points[i * 3 + 2] = zStart + pitch * phi;
    }

    paths.push({ layer, turns, points });
  }

  return paths;
}

/**
 * The inner-end lead-in centerline (issue #8, docs/research.md "Wire ends"):
 * `innerEnd.ts`'s own `channelPath` (keyhole-to-groove order), flattened flat
 * at z=0 (the flange's inner face -- the channel is a shallow recess there,
 * not a helix). Deliberately kept OUT of `buildWirePaths`'s own per-layer
 * `WireLayerPath.points` (layer 1's path there sits at one constant radial
 * offset for its WHOLE run and climbs z monotonically at a constant pitch --
 * invariants test/wire.test.ts checks precisely -- which a flat, varying-
 * radius lead-in prefix would break): a separate small curve the viewer
 * draws alongside layer 1's own tube instead, so the wound-cable schematic
 * still reads as one continuous line from the keyhole through the channel
 * into the groove, without disturbing layer 1's own solved geometry.
 */
export function buildInnerEndLeadIn(channelPath: XY[]): Float32Array {
  const points = new Float32Array(channelPath.length * 3);
  for (let i = 0; i < channelPath.length; i++) {
    points[i * 3] = channelPath[i].x;
    points[i * 3 + 1] = channelPath[i].y;
    points[i * 3 + 2] = 0;
  }
  return points;
}
