import { expect } from "vitest";

export type P3 = [number, number, number];

/**
 * Discrete curvature at every interior sample: the turning angle between the
 * two adjoining segments divided by their mean length. Returns the worst
 * sample (curvature and position), so a failure names WHERE the cable bends
 * too sharply.
 */
export function worstCurvature(points: Float32Array): { k: number; at: P3; index: number } {
  const p = (i: number): P3 => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  const n = points.length / 3;
  let worst = { k: 0, at: [0, 0, 0] as P3, index: -1 };
  for (let i = 1; i + 1 < n; i++) {
    const a = p(i - 1);
    const b = p(i);
    const c = p(i + 1);
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
    if (ab < 1e-6 || bc < 1e-6) continue;
    const dot = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) + (b[2] - a[2]) * (c[2] - b[2])) / (ab * bc);
    const k = Math.acos(Math.max(-1, Math.min(1, dot))) / ((ab + bc) / 2);
    if (k > worst.k) worst = { k, at: b, index: i };
  }
  return worst;
}

export function expectWithinBendLimit(points: Float32Array, mbr: number, label: string) {
  expect(points.length, `${label}: has samples`).toBeGreaterThanOrEqual(6);
  const w = worstCurvature(points);
  const where = `sample ${w.index} at (${w.at.map((v) => v.toFixed(1)).join(", ")}), bend radius ${(1 / w.k).toFixed(2)} mm vs MBR ${mbr.toFixed(1)} mm`;
  expect(w.k * mbr, `${label}: sharpest bend at ${where}`).toBeLessThanOrEqual(1.05);
}

