import { expect } from "vitest";
import type { Design } from "../../src/core";

const SAMPLES_PER_DIAMETER = 8;
const NEIGHBOURHOOD_DIAMETERS = 3;
export const SELF_CLEARANCE_FRACTION = 0.98;

export interface Clearance {
  min: number;
  at: [number, number, number];
  other: [number, number, number];
}

function resample(points: Float32Array, step: number): { xyz: Float64Array; arc: Float64Array } {
  const xyz: number[] = [points[0], points[1], points[2]];
  const arc: number[] = [0];
  let travelled = 0;
  let nextAt = step;
  for (let i = 3; i < points.length; i += 3) {
    const [ax, ay, az] = [points[i - 3], points[i - 2], points[i - 1]];
    const [bx, by, bz] = [points[i], points[i + 1], points[i + 2]];
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    while (travelled + len >= nextAt && len > 0) {
      const t = (nextAt - travelled) / len;
      xyz.push(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az));
      arc.push(nextAt);
      nextAt += step;
    }
    travelled += len;
  }
  return { xyz: Float64Array.from(xyz), arc: Float64Array.from(arc) };
}

/**
 * The least centre-to-centre distance between two passes of the cable: samples every d / 8 along the path, any two
 * more than 3 d apart along it (so a pass is never compared with its own neighbourhood).
 */
export function minSelfClearance(points: Float32Array, diameter: number): Clearance {
  const { xyz, arc } = resample(points, diameter / SAMPLES_PER_DIAMETER);
  const n = arc.length;
  const cell = diameter;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) {
    const k = key(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  const apart = NEIGHBOURHOOD_DIAMETERS * diameter;
  let best: Clearance = { min: Infinity, at: [0, 0, 0], other: [0, 0, 0] };
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]];
    const [cx, cy, cz] = [Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j <= i || arc[j] - arc[i] <= apart) continue;
            const dist = Math.hypot(xyz[3 * j] - x, xyz[3 * j + 1] - y, xyz[3 * j + 2] - z);
            if (dist < best.min) best = { min: dist, at: [x, y, z], other: [xyz[3 * j], xyz[3 * j + 1], xyz[3 * j + 2]] };
          }
        }
      }
    }
  }
  return best;
}

export function expectSelfClear(points: Float32Array, diameter: number, label: string) {
  const c = minSelfClearance(points, diameter);
  const where = `(${c.at.map((v) => v.toFixed(1)).join(", ")}) and (${c.other.map((v) => v.toFixed(1)).join(", ")})`;
  expect(c.min, `${label}: two passes of the cable come ${c.min.toFixed(2)} mm apart at ${where}, less than ${SELF_CLEARANCE_FRACTION} of its ${diameter} mm`).toBeGreaterThanOrEqual(SELF_CLEARANCE_FRACTION * diameter);
}

/** The layers and the outer end joined in order: the cable that lies on the base, leaving out the inner end that dives into the channel. */
export function woundWithLeadOut(d: Design): Float32Array {
  const pieces = [...d.wirePaths.map((w) => w.points), d.outerEndLeadOut];
  const out = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
