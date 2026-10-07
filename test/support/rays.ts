import type { CoilMesh } from "../../src/core";

export type Vec = [number, number, number];

/** Distances along the ray from `origin` along unit `dir` to each triangle of `mesh` it crosses, nearest first (Moller-Trumbore). */
export function rayHits(mesh: CoilMesh, origin: Vec, dir: Vec): number[] {
  const { positions: P, indices: I } = mesh;
  const hits: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t];
    const b = 3 * I[t + 1];
    const c = 3 * I[t + 2];
    const e1: Vec = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2: Vec = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const h: Vec = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) continue;
    const s: Vec = [origin[0] - P[a], origin[1] - P[a + 1], origin[2] - P[a + 2]];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const q: Vec = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const d = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (d > 1e-6) hits.push(d);
  }
  const sorted = hits.sort((x, y) => x - y);
  return sorted.filter((h, i) => i === 0 || h - sorted[i - 1] > 1e-4);
}
