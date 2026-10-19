import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WireLayerPath } from "../core";

const MIN_TURNS_FOR_ENVELOPE = 12;
const MIN_TUBE_DIAMETER_PX = 4.8;
const TUBE_RADIAL_SEGMENTS = 24;
const ENVELOPE_RADIAL_SEGMENTS = 64;
const HINT_SPAN_TURNS = 2;
const HINT_SPACING_TURNS = 6;
const MIN_HINTS = 3;
const MAX_HINTS = 40;
const HINT_RADIUS_FRACTION = 0.12;
const ENVELOPE_OUTSET_IN_WIRE_RADII = 0.5;
const Y_AXIS_TO_Z_AXIS_ANGLE = Math.PI / 2;

function withoutUv(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.deleteAttribute("uv");
  return geometry;
}

function pointAt(points: Float32Array, i: number): THREE.Vector3 {
  return new THREE.Vector3(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
}

function curveFromRange(points: Float32Array, fromSample: number, toSample: number): THREE.CatmullRomCurve3 {
  const vecs: THREE.Vector3[] = [];
  for (let i = fromSample; i <= toSample; i++) vecs.push(pointAt(points, i));
  return new THREE.CatmullRomCurve3(vecs, false, "catmullrom", 0);
}

function fullTube(path: WireLayerPath, wireRadius: number): THREE.BufferGeometry {
  const sampleCount = path.points.length / 3;
  const curve = curveFromRange(path.points, 0, sampleCount - 1);
  const tubularSegments = Math.max(sampleCount - 1, 8);
  return withoutUv(new THREE.TubeGeometry(curve, tubularSegments, wireRadius, TUBE_RADIAL_SEGMENTS, false));
}

function envelopeShell(path: WireLayerPath, wireRadius: number): THREE.BufferGeometry {
  const sampleCount = path.points.length / 3;
  const first = pointAt(path.points, 0);
  const last = pointAt(path.points, sampleCount - 1);
  const radius = Math.hypot(first.x, first.y) + wireRadius * ENVELOPE_OUTSET_IN_WIRE_RADII;
  const zLo = Math.min(first.z, last.z);
  const zHi = Math.max(first.z, last.z);
  const height = Math.max(1e-3, zHi - zLo);

  const cyl = new THREE.CylinderGeometry(radius, radius, height, ENVELOPE_RADIAL_SEGMENTS, 1, true);
  cyl.rotateX(Y_AXIS_TO_Z_AXIS_ANGLE);
  cyl.translate(0, 0, (zLo + zHi) / 2);
  return withoutUv(cyl);
}

function hintCenters(turns: number): number[] {
  const span = Math.min(HINT_SPAN_TURNS, turns);
  if (turns <= span) return [turns / 2];

  const firstToLastCenterDistance = turns - span;
  const count = Math.min(MAX_HINTS, Math.max(MIN_HINTS, Math.round(firstToLastCenterDistance / HINT_SPACING_TURNS) + 1));
  if (count === 1) return [turns / 2];

  return Array.from({ length: count }, (_, i) => span / 2 + (i * firstToLastCenterDistance) / (count - 1));
}

function hintTubes(path: WireLayerPath, hintRadius: number): THREE.BufferGeometry[] {
  const sampleCount = path.points.length / 3;
  if (sampleCount < 2 || path.turns <= 0) return [];

  const samplesPerTurn = (sampleCount - 1) / path.turns;
  const halfSpanSamples = Math.max(1, Math.round((Math.min(HINT_SPAN_TURNS, path.turns) / 2) * samplesPerTurn));

  const tubes: THREE.BufferGeometry[] = [];
  for (const centerPhi of hintCenters(path.turns)) {
    const center = Math.round((centerPhi / path.turns) * (sampleCount - 1));
    const from = Math.max(0, center - halfSpanSamples);
    const to = Math.min(sampleCount - 1, center + halfSpanSamples);
    if (to <= from) continue;
    const curve = curveFromRange(path.points, from, to);
    tubes.push(withoutUv(new THREE.TubeGeometry(curve, Math.max(to - from, 4), hintRadius, TUBE_RADIAL_SEGMENTS, false)));
  }
  return tubes;
}

function screenExtentMm(wirePaths: WireLayerPath[], wireRadius: number): number {
  let zLo = Infinity;
  let zHi = -Infinity;
  let reach = 0;
  for (const { points } of wirePaths) {
    for (let i = 0; i < points.length; i += 3) {
      reach = Math.max(reach, Math.hypot(points[i], points[i + 1]));
      zLo = Math.min(zLo, points[i + 2]);
      zHi = Math.max(zHi, points[i + 2]);
    }
  }
  return zHi - zLo + 2 * (reach + wireRadius);
}

export function needsEnvelope(wirePaths: WireLayerPath[], wireRadius: number, canvasHeightPx: number): boolean {
  if (!wirePaths.some((p) => p.turns > MIN_TURNS_FOR_ENVELOPE)) return false;
  const tubeDiameterPx = (canvasHeightPx * 2 * wireRadius) / screenExtentMm(wirePaths, wireRadius);
  return tubeDiameterPx < MIN_TUBE_DIAMETER_PX;
}

export function reachFramePoints(path: ArrayLike<number>, wireRadius: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i + 2 < path.length; i += 3) {
    const [x, y, z] = [path[i], path[i + 1], path[i + 2]];
    out.push(x + wireRadius, y, z, x - wireRadius, y, z, x, y + wireRadius, z, x, y - wireRadius, z, x, y, z + wireRadius, x, y, z - wireRadius);
  }
  return new Float32Array(out);
}

export function buildCableTube(cablePath: Float32Array, wireRadius: number): THREE.BufferGeometry {
  return fullTube({ layer: 0, turns: 1, points: cablePath }, wireRadius);
}

export function buildWireGeometries(wirePaths: WireLayerPath[], wireRadius: number, envelope: boolean): THREE.BufferGeometry[] {
  return wirePaths.map((path) => {
    if (!envelope || path.turns <= MIN_TURNS_FOR_ENVELOPE) return fullTube(path, wireRadius);

    const layerRadius = Math.hypot(path.points[0], path.points[1]);
    const hintRadius = Math.max(wireRadius, layerRadius * HINT_RADIUS_FRACTION);

    const parts = [envelopeShell(path, wireRadius), ...hintTubes(path, hintRadius)];
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    return merged ?? envelopeShell(path, wireRadius);
  });
}
