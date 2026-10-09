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
import type { FaceChannelLayout, FaceEnd, OuterStart } from "./faceChannel";
import { pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { grooveShape, grooveStartHeight } from "./wall";
import type { LayerResult, Resolution, WireLayerPath } from "./types";

const MAX_TOTAL_SAMPLES_PER_LAYER = 300_000;
const MIN_SAMPLES_PER_TURN_FLOOR = 8;

const TRANSITION_TURNS_MAX = 1.5;
const TANGENT_PROBE_TURNS = 1e-5;
const DUPLICATE_SAMPLE_DISTANCE = 1e-4;

function samplesPerTurn(helixLength: number, minPerTurn: number, maxArcLength: number): number {
  return Math.max(minPerTurn, Math.ceil(helixLength / maxArcLength));
}

export interface LayerRun {
  layer: number;
  turns: number;
  offsetAt(local: number): number;
  start: number;
  z(local: number): number;
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

export function woundReachOffset(envelopeOffset: number, wireDiameter: number, woundLayers: number, topCap: boolean): number {
  if (woundLayers % 2 === 0 && (topCap || woundLayers > 0)) return envelopeOffset + wireDiameter;
  if (!topCap) return envelopeOffset;
  return Math.max(envelopeOffset, wireDiameter + CAP_LEAD_OUT_WALL_GAP);
}

export interface CableEnds {
  innerEnd?: InnerEndLayout;
  faceChannels?: FaceChannelLayout;
  topCapEnabled: boolean;
  wallHeight: number;
  flangeMargin: number;
  tolerance: number;
  bendRadius: number;
}

export interface WoundCable {
  wirePaths: WireLayerPath[];
  innerEndLeadIn: Float32Array;
  layerTransitions: Float32Array[];
  outerEndLeadOut: Float32Array;
  cablePath: Float32Array;
  outerEndU: number;
  warnings: string[];
}

function nthFromEnd(points: Float32Array, k: number): [number, number, number] {
  const n = points.length - 3 * (k + 1);
  return [points[n], points[n + 1], points[n + 2]];
}

function joinPieces(pieces: Float32Array[]): Float32Array {
  const out: number[] = [];
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i += 3) {
      const n = out.length;
      if (n >= 3 && Math.hypot(piece[i] - out[n - 3], piece[i + 1] - out[n - 2], piece[i + 2] - out[n - 1]) < DUPLICATE_SAMPLE_DISTANCE) continue;
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

function faceChannelLeadOut(channel: FaceEnd): Float32Array {
  return new Float32Array(faceEndPath(channel).flatMap((p) => [p.x, p.y, p.z]));
}

function straightTailLeadOut(outline: ShapeOutline, last: LayerRun, wireDiameter: number): Float32Array {
  const uEnd = last.start + last.turns;
  const zEnd = last.z(last.turns);
  const lastOffset = last.offsetAt(last.turns);
  const before = pointAt(outline, uEnd - TANGENT_PROBE_TURNS, lastOffset);
  const end = pointAt(outline, uEnd, lastOffset);
  const tx = end.x - before.x;
  const ty = end.y - before.y;
  const tz = last.slope * TANGENT_PROBE_TURNS;
  const len = Math.hypot(tx, ty, tz);
  const tail = Math.max(CABLE_TAIL_MIN, CABLE_TAIL_FACTOR * wireDiameter);
  const steps = Math.max(2, Math.ceil(tail / (4 * CABLE_BRIDGE_STEP)));
  const leadOut = new Float32Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i++) {
    const s = (tail * i) / steps;
    leadOut[i * 3] = end.x + (tx / len) * s;
    leadOut[i * 3 + 1] = end.y + (ty / len) * s;
    leadOut[i * 3 + 2] = zEnd + (tz / len) * s;
  }
  return leadOut;
}

function capLeadOut(outline: ShapeOutline, last: LayerRun, lastPoints: Float32Array, wireDiameter: number, ends: CableEnds, limit: number) {
  const uEnd = last.start + last.turns;
  const zEnd = last.z(last.turns);
  const d = wireDiameter;
  const zKey = ends.wallHeight + capCableZ(d);
  const o0 = last.offsetAt(last.turns);
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
  const warning = found.ok ? undefined : `On its way up to the top cap the cable bends tighter than it should (its bend radius is ${(ends.bendRadius / 10).toFixed(1)} cm).`;
  const outerEndU = uEnd + found.turns;
  const tail = capTailPath(outline, ends.flangeMargin, oKey, d, ends.bendRadius, outerEndU).flatMap((p) => [p.x, p.y, zKey]);
  return { leadOut: joinPieces([found.points, new Float32Array(tail)]), outerEndU, warning };
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
  let outerEndLeadOut: Float32Array;
  let outerEndU = last.start + last.turns;

  if (ends.faceChannels?.outer) {
    outerEndLeadOut = faceChannelLeadOut(ends.faceChannels.outer);
  } else if (!ends.topCapEnabled) {
    outerEndLeadOut = straightTailLeadOut(outline, last, wireDiameter);
  } else {
    const lifted = capLeadOut(outline, last, wirePaths.at(-1)!.points, wireDiameter, ends, limit);
    if (lifted.warning) warnings.push(lifted.warning);
    outerEndLeadOut = lifted.leadOut;
    outerEndU = lifted.outerEndU;
  }

  const pieces: Float32Array[] = [innerEndLeadIn];
  wirePaths.forEach((p, i) => {
    pieces.push(p.points);
    if (layerTransitions[i]) pieces.push(layerTransitions[i]);
  });
  pieces.push(outerEndLeadOut);

  return { wirePaths, innerEndLeadIn, layerTransitions, outerEndLeadOut, cablePath: joinPieces(pieces), outerEndU, warnings };
}
