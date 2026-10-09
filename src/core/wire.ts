// The drawn wound cable (issue #4, docs/design.md, Rendering):
// never exported, never its own solid -- a dense centreline the viewer lofts
// into ONE tube, so the wound cable reads as a distinct body in the line-art
// renderer.
//
// Reuses the exact numbers the solver and the wall already computed --
// `LayerResult.offset`/`.turns`/`.perimeter` (capacity.ts) and the wall's own
// groove `pitch`/`zStart` (wall.ts's `createWallProfile`) -- so layer 1's
// cable sits centred in the printed groove. (x, y) comes from `shapes.ts`'s
// `pointAt(outline, t, offset)`, the same arc-length-parameterised outline
// the wall's helix and the STEP fit sample, so a square or triangle core's
// cable follows the real offset outline, not a circle.
//
// Issue #68 ("one continuous cable"): a real coil is TRAVERSE-wound -- the
// core keeps spinning the same way while the cable's climb reverses every
// layer (odd layers climb, even layers descend), so each layer picks up
// where the previous one finished.
//
// Issue #115 ("respect the bend radius"): the whole cable -- inner-end
// lead-in, layers, transitions, outer end -- is one G1 path whose curvature
// stays within 1/MBR (MBR = bend multiplier * diameter). So:
//   - each layer starts at the ANGLE where the previous one's transition
//     ends (the core keeps turning forward), instead of at a fixed phase --
//     a fixed phase made the transition turn back on itself;
//   - each transition is a blend in the outline's own (u, offset, z) space,
//     lengthened until its curvature passes (CABLE_BEND_CHECK);
//   - the inner-end lead-in is innerEnd.ts's tangential chord;
//   - the outer end: with the top cap on, a blend (searched the same way)
//     to just under the cap, then out past the rim under the cap's rim slot
//     (issue #241, laid out where that blend ends); with the cap off, a
//     straight tail along the last turn's tangent.

import {
  CABLE_BEND_CHECK,
  CABLE_BRIDGE_STEP,
  CABLE_TAIL_FACTOR,
  CABLE_TAIL_MIN,
  CAP_LEAD_OUT_WALL_GAP,
  CLIMB_OFFSET_SPAN,
  CROSSING_MIN_LAYERS,
  DRAFT_WIRE_MAX_ARC_LENGTH,
  DRAFT_WIRE_MIN_SAMPLES_PER_TURN,
  FINAL_WIRE_MAX_ARC_LENGTH,
  FINAL_WIRE_MIN_SAMPLES_PER_TURN,
  LEAD_OUT_TURNS_MAX,
  MARGIN_BOTTOM,
} from "./constants";
import { phaseShiftTurns } from "./capacity";
import { outlineBlend, searchBlend, unitRamp, withNeighbours } from "./blend";
import { capCableZ, capTailPath } from "./innerEnd";
import type { InnerEndLayout } from "./innerEnd";
import { faceEndPath } from "./faceChannel";
import type { FaceChannelLayout, OuterStart } from "./faceChannel";
import { pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { grooveShape, grooveStartHeight } from "./wall";
import type { LayerResult, Resolution, WireLayerPath } from "./types";

// A hard safety backstop on total samples per layer, so a pathological input
// (well outside the solver's practical bounds) can't allocate unbounded
// memory: if the arc-length target would exceed it, density is scaled back
// (never below MIN_SAMPLES_PER_TURN_FLOOR) rather than sampling that densely.
const MAX_TOTAL_SAMPLES_PER_LAYER = 300_000;
const MIN_SAMPLES_PER_TURN_FLOOR = 8;

const TRANSITION_TURNS_MAX = 1.5;

/**
 * Samples per turn for the given per-turn helix length: at least
 * `minPerTurn` (so even a tiny turn is smooth), and enough to keep
 * consecutive samples at most `maxArcLength` mm apart along the curve.
 */
function samplesPerTurn(helixLength: number, minPerTurn: number, maxArcLength: number): number {
  return Math.max(minPerTurn, Math.ceil(helixLength / maxArcLength));
}

/** One wound layer's own geometry: where it starts around the outline, and its z as a function of how far along it is. */
export interface LayerRun {
  layer: number;
  turns: number;
  /** The radial offset (outside the outline) at `local` turns into the layer. */
  offsetAt(local: number): number;
  /** The outline parameter (`pointAt`'s t, in turns) of the layer's first sample. */
  start: number;
  /** z at `local` turns into the layer. Odd layers climb, even layers descend. */
  z(local: number): number;
  /** dz per turn (constant): +pitch climbing, -pitch descending. */
  slope: number;
}

function layerRun(result: LayerResult, start: number, pitch: number, zStart: number, windingQuality: number, offsetAt: (local: number) => number): LayerRun {
  const { layer, turns } = result;
  const shift = phaseShiftTurns(layer, windingQuality);
  const climbs = (layer - 1) % 2 === 0;
  return {
    layer,
    turns,
    offsetAt,
    start,
    // Odd layers: `zStart + pitch*(shift + local)`. Even layers mirror that
    // about the layer's own midpoint, so the first sample lands at the top
    // (next to where the climbing layer below finished) and the last at the
    // bottom (issue #68).
    z: (local) => (climbs ? zStart + pitch * (shift + local) : zStart + pitch * (shift + turns - local)),
    slope: climbs ? pitch : -pitch,
  };
}

function samplePoint(outline: ShapeOutline, run: LayerRun, local: number): [number, number, number] {
  const p = pointAt(outline, run.start + local, run.offsetAt(local));
  return [p.x, p.y, run.z(local)];
}

function sampleLayer(outline: ShapeOutline, run: LayerRun, perimeter: number, pitch: number, resolution: Resolution): Float32Array {
  const [minPerTurn, maxArcLength] =
    resolution === "draft" ? [DRAFT_WIRE_MIN_SAMPLES_PER_TURN, DRAFT_WIRE_MAX_ARC_LENGTH] : [FINAL_WIRE_MIN_SAMPLES_PER_TURN, FINAL_WIRE_MAX_ARC_LENGTH];
  let perTurn = samplesPerTurn(Math.hypot(perimeter, pitch), minPerTurn, maxArcLength);
  if (run.turns * perTurn > MAX_TOTAL_SAMPLES_PER_LAYER) {
    perTurn = Math.max(MIN_SAMPLES_PER_TURN_FLOOR, Math.floor(MAX_TOTAL_SAMPLES_PER_LAYER / run.turns));
  }
  const count = Math.max(2, Math.round(run.turns * perTurn) + 1);
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) points.set(samplePoint(outline, run, (run.turns * i) / (count - 1)), i * 3);
  return points;
}

/**
 * How far outside the core's outline the drawn cable reaches (its outer
 * surface), with the top cap on: the outer end's run up to the cap. A last
 * layer that ends at the bottom (an even layer count) is climbed past
 * outside itself, one cable diameter beyond the wound envelope
 * (`envelopeOffset`, the outermost layer's); one that ends at the top runs on
 * at its own offset, but never closer to the wall than CAP_LEAD_OUT_WALL_GAP
 * (a single layer sits half in the groove, and the groove has faded out
 * there). The flange and cap must cover this, not just the envelope.
 */
export function woundReachOffset(envelopeOffset: number, wireDiameter: number, woundLayers: number, topCap: boolean): number {
  if (woundLayers % 2 === 0 && (topCap || woundLayers > 0)) return envelopeOffset + wireDiameter;
  if (!topCap) return envelopeOffset;
  return Math.max(envelopeOffset, wireDiameter + CAP_LEAD_OUT_WALL_GAP);
}

export interface CableEnds {
  /** The inner-end layout (innerEnd.ts), whose `leadIn` starts the cable. */
  innerEnd?: InnerEndLayout;
  faceChannels?: FaceChannelLayout;
  topCapEnabled: boolean;
  /** The wall's own height (the top cap's underside, assembled frame). */
  height: number;
  /** The flange (and top cap) margin, mm. */
  margin: number;
  tolerance: number;
  /** The cable's minimum bend radius, mm. */
  bendRadius: number;
}

export interface WoundCable {
  wirePaths: WireLayerPath[];
  innerEndLeadIn: Float32Array;
  layerTransitions: Float32Array[];
  outerEndLeadOut: Float32Array;
  /** Everything above joined end to end, inner fix point to outer end. */
  cablePath: Float32Array;
  /** The outline parameter where the outer end leaves the coil (issue #241: the rim slots are laid out here): where the lead-out arrives under the cap, or the last turn's end with the cap off. */
  outerEndU: number;
  warnings: string[];
}

function nthFromEnd(points: Float32Array, k: number): [number, number, number] {
  const n = points.length - 3 * (k + 1);
  return [points[n], points[n + 1], points[n + 2]];
}

/** `pieces` end to end, dropping each join's duplicated sample. */
function joinPieces(pieces: Float32Array[]): Float32Array {
  const out: number[] = [];
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i += 3) {
      const n = out.length;
      if (n >= 3 && Math.hypot(piece[i] - out[n - 3], piece[i + 1] - out[n - 2], piece[i + 2] - out[n - 1]) < 1e-4) continue;
      out.push(piece[i], piece[i + 1], piece[i + 2]);
    }
  }
  return new Float32Array(out);
}

export interface WoundLayers {
  wirePaths: WireLayerPath[];
  layerTransitions: Float32Array[];
  runs: LayerRun[];
  warnings: string[];
}

export function windLayers(layerResults: LayerResult[], outline: ShapeOutline, wireDiameter: number, windingQuality: number, resolution: Resolution, bendRadius: number): WoundLayers {
  const groove = grooveShape(wireDiameter);
  const { pitch } = groove;
  const zStart = grooveStartHeight(groove, MARGIN_BOTTOM);
  const limit = CABLE_BEND_CHECK / bendRadius;
  const warnings: string[] = [];

  const wirePaths: WireLayerPath[] = [];
  const runs: LayerRun[] = [];
  const layerTransitions: Float32Array[] = [];

  for (const result of layerResults) {
    if (result.turns <= 0) continue;
    const prev = runs.at(-1);
    let start = 0;
    if (prev) {
      const prevPoints = wirePaths.at(-1)!.points;
      const u0 = prev.start + prev.turns;
      const next = layerRun(result, 0, pitch, zStart, windingQuality, () => result.offset);
      const z0 = prev.z(prev.turns);
      const z1 = next.z(0);
      const o1 = result.offset;
      const hop = (o0: number, before: [number, number, number], minTurns?: number) =>
        searchBlend(
          (turns) => {
            const points = outlineBlend(outline, u0, turns, (sigma) => o0 + (o1 - o0) * unitRamp(sigma), z0, prev.slope, z1, next.slope);
            const after = samplePoint(outline, { ...next, start: u0 + turns }, 1 / result.perimeter);
            return { points, check: withNeighbours(before, points, after) };
          },
          limit,
          TRANSITION_TURNS_MAX,
          minTurns,
        );
      const found = hop(prev.offsetAt(prev.turns), nthFromEnd(prevPoints, 1));
      if (!found.ok) warnings.push(`Between layers ${prev.layer} and ${result.layer} the cable bends tighter than it should (its bend radius is ${(bendRadius / 10).toFixed(1)} cm).`);
      layerTransitions.push(found.points);
      start = u0 + found.turns;
    }
    const run = layerRun(result, start, pitch, zStart, windingQuality, () => result.offset);
    runs.push(run);
    wirePaths.push({ layer: run.layer, turns: run.turns, points: sampleLayer(outline, run, result.perimeter, pitch, resolution) });
  }

  return { wirePaths, layerTransitions, runs, warnings };
}

export function outerStartOf(wound: WoundLayers): OuterStart | undefined {
  const { runs, wirePaths, layerTransitions } = wound;
  if (runs.length < CROSSING_MIN_LAYERS) return undefined;
  const last = runs.at(-1)!;
  const ascends = last.slope > 0;
  const neighbour = ascends ? runs.at(-2)! : last;
  const under = ascends ? -1 : undefined;
  let stackTop = -Infinity;
  for (const points of [...wirePaths.slice(0, under).map((p) => p.points), ...layerTransitions.slice(0, under)]) {
    for (let i = 2; i < points.length; i += 3) stackTop = Math.max(stackTop, points[i]);
  }
  const t = last.start + last.turns;
  const z = last.z(last.turns);
  const phase = (((t - neighbour.start) % 1) + 1) % 1;
  const neighbourTurns: number[] = [];
  for (let local = phase; local <= neighbour.turns; local += 1) {
    if (neighbour.z(local) >= z - Math.abs(neighbour.slope)) neighbourTurns.push(neighbour.z(local));
  }
  return { t, z, slope: last.slope, offset: last.offsetAt(last.turns), neighbourOffset: neighbour.offsetAt(neighbour.turns), neighbourTurns, neighbourSlope: neighbour.slope, stackTop };
}

export function buildCable(wound: WoundLayers, outline: ShapeOutline, wireDiameter: number, ends: CableEnds): WoundCable {
  const { wirePaths, layerTransitions, runs } = wound;
  const warnings = [...wound.warnings];
  const limit = CABLE_BEND_CHECK / ends.bendRadius;

  if (runs.length === 0) {
    return { wirePaths, innerEndLeadIn: new Float32Array(0), layerTransitions, outerEndLeadOut: new Float32Array(0), cablePath: new Float32Array(0), outerEndU: 0, warnings };
  }

  const innerEndLeadIn = new Float32Array((ends.faceChannels?.inner ? faceEndPath(ends.faceChannels.inner).reverse() : (ends.innerEnd?.leadIn ?? [])).flatMap((p) => [p.x, p.y, p.z]));

  const last = runs.at(-1)!;
  const lastPoints = wirePaths.at(-1)!.points;
  const uEnd = last.start + last.turns;
  const zEnd = last.z(last.turns);
  const lastOffset = last.offsetAt(last.turns);
  let outerEndLeadOut: Float32Array;
  let outerEndU = uEnd;

  if (ends.faceChannels?.outer) {
    outerEndLeadOut = new Float32Array(faceEndPath(ends.faceChannels.outer).flatMap((p) => [p.x, p.y, p.z]));
  } else if (!ends.topCapEnabled) {
    const EPS = 1e-5;
    const a = pointAt(outline, uEnd - EPS, lastOffset);
    const b = pointAt(outline, uEnd, lastOffset);
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const tz = last.slope * EPS;
    const len = Math.hypot(tx, ty, tz);
    const tail = Math.max(CABLE_TAIL_MIN, CABLE_TAIL_FACTOR * wireDiameter);
    const steps = Math.max(2, Math.ceil(tail / (4 * CABLE_BRIDGE_STEP)));
    outerEndLeadOut = new Float32Array((steps + 1) * 3);
    for (let i = 0; i <= steps; i++) {
      const s = (tail * i) / steps;
      outerEndLeadOut[i * 3] = b.x + (tx / len) * s;
      outerEndLeadOut[i * 3 + 1] = b.y + (ty / len) * s;
      outerEndLeadOut[i * 3 + 2] = zEnd + (tz / len) * s;
    }
  } else {
    const d = wireDiameter;
    const zKey = ends.height + capCableZ(d);
    const o0 = lastOffset;
    const climbsAll = last.slope < 0;
    const oKey = climbsAll ? o0 + d : Math.max(o0, d / 2 + CAP_LEAD_OUT_WALL_GAP);
    const offsetAt = climbsAll ? (s: number) => o0 + (oKey - o0) * unitRamp(Math.min(1, s / CLIMB_OFFSET_SPAN)) : (s: number) => o0 + (oKey - o0) * unitRamp(s);
    const found = searchBlend(
      (turns) => {
        const points = outlineBlend(outline, uEnd, turns, offsetAt, zEnd, last.slope, zKey, 0);
        return { points, check: withNeighbours(nthFromEnd(lastPoints, 1), points) };
      },
      limit,
      LEAD_OUT_TURNS_MAX,
    );
    if (!found.ok) warnings.push(`On its way up to the top cap the cable bends tighter than it should (its bend radius is ${(ends.bendRadius / 10).toFixed(1)} cm).`);
    outerEndU = uEnd + found.turns;
    const tail = capTailPath(outline, ends.margin, oKey, d, ends.bendRadius, outerEndU).flatMap((p) => [p.x, p.y, zKey]);
    outerEndLeadOut = joinPieces([found.points, new Float32Array(tail)]);
  }

  const pieces: Float32Array[] = [innerEndLeadIn];
  wirePaths.forEach((p, i) => {
    pieces.push(p.points);
    if (layerTransitions[i]) pieces.push(layerTransitions[i]);
  });
  pieces.push(outerEndLeadOut);

  return { wirePaths, innerEndLeadIn, layerTransitions, outerEndLeadOut, cablePath: joinPieces(pieces), outerEndU, warnings };
}
