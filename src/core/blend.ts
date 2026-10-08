import { CABLE_BRIDGE_STEP } from "./constants";
import { bump } from "./innerEnd";
import { offsetPerimeter, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";

const BRIDGE_TURNS_MIN = 0.1;
const BRIDGE_TURNS_STEP = 0.05;

export function hermite(s: number, v0: number, d0: number, v1: number, d1: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * d0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * d1;
}

export const unitRamp = bump(1, 0, 1).value;

function outlineSpeed(outline: ShapeOutline, u: number, offset: number, dir: 1 | -1): number {
  const EPS = 1e-6;
  const a = pointAt(outline, u, offset);
  const b = pointAt(outline, u + dir * EPS, offset);
  return Math.hypot(b.x - a.x, b.y - a.y) / EPS;
}

export function outlineBlend(outline: ShapeOutline, u0: number, turns: number, offsetAt: (sigma: number) => number, z0: number, dz0: number, z1: number, dz1: number): Float32Array {
  const approxLength = turns * offsetPerimeter(outline, Math.max(offsetAt(0), offsetAt(1))) + Math.abs(z1 - z0);
  const steps = Math.max(16, Math.ceil(approxLength / CABLE_BRIDGE_STEP));
  const xy = new Float64Array((steps + 1) * 2);
  const sigma = Float64Array.from({ length: steps + 1 }, (_, i) => i / steps);
  let length = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i <= steps; i++) {
      const p = pointAt(outline, u0 + (turns * i) / steps, offsetAt(sigma[i]));
      xy[i * 2] = p.x;
      xy[i * 2 + 1] = p.y;
    }
    const cumulative = [0];
    for (let i = 1; i <= steps; i++) cumulative.push(cumulative[i - 1] + Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]));
    length = cumulative[steps] || 1;
    for (let i = 0; i <= steps; i++) sigma[i] = cumulative[i] / length;
  }
  const d0 = (dz0 / outlineSpeed(outline, u0, offsetAt(0), 1)) * length;
  const d1 = (dz1 / outlineSpeed(outline, u0 + turns, offsetAt(1), -1)) * length;
  const points = new Float32Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i++) {
    points[i * 3] = xy[i * 2];
    points[i * 3 + 1] = xy[i * 2 + 1];
    points[i * 3 + 2] = hermite(sigma[i], z0, d0, z1, d1);
  }
  return points;
}

export function maxCurvature(points: ArrayLike<number>): number {
  let worst = 0;
  const n = points.length / 3;
  for (let i = 1; i + 1 < n; i++) {
    const ax = points[i * 3] - points[i * 3 - 3];
    const ay = points[i * 3 + 1] - points[i * 3 - 2];
    const az = points[i * 3 + 2] - points[i * 3 - 1];
    const bx = points[i * 3 + 3] - points[i * 3];
    const by = points[i * 3 + 4] - points[i * 3 + 1];
    const bz = points[i * 3 + 5] - points[i * 3 + 2];
    const la = Math.hypot(ax, ay, az);
    const lb = Math.hypot(bx, by, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb)));
    worst = Math.max(worst, Math.acos(cos) / ((la + lb) / 2));
  }
  return worst;
}

export function withNeighbours(before: [number, number, number], blend: Float32Array, after?: [number, number, number]): number[] {
  return [...before, ...blend, ...(after ?? [])];
}

export function searchBlend(build: (turns: number) => { points: Float32Array; check: number[] }, limit: number, maxTurns: number, minTurns = BRIDGE_TURNS_MIN): { turns: number; points: Float32Array; ok: boolean } {
  let best: { turns: number; points: Float32Array; k: number } | undefined;
  for (let turns = minTurns; turns <= maxTurns + 1e-9; turns += BRIDGE_TURNS_STEP) {
    const { points, check } = build(turns);
    const k = maxCurvature(check);
    if (k <= limit) return { turns, points, ok: true };
    if (!best || k < best.k) best = { turns, points, k };
  }
  return { turns: best!.turns, points: best!.points, ok: false };
}
