import type { CoilMesh } from "./types";
import { WELD_EPSILON } from "./weld";

const SHORT_EDGE = WELD_EPSILON - 1e-4;
const FOLD_COS = Math.cos((8 * Math.PI) / 180);
const MIN_HEIGHT = 1e-3;

export function hasShortEdge(mesh: CoilMesh): boolean {
  const { positions: P, indices: I } = mesh;
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [I[t + k], I[t + ((k + 1) % 3)]];
      if (a < b && Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]) < SHORT_EDGE) return true;
    }
  }
  return false;
}

export function hasFoldEdge(mesh: CoilMesh): boolean {
  const { positions: P, indices: I } = mesh;
  const triangles = I.length / 3;
  const normals = new Float64Array(I.length);
  const real = new Uint8Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [3 * I[3 * t], 3 * I[3 * t + 1], 3 * I[3 * t + 2]];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const w = [P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(n[0], n[1], n[2]);
    real[t] = length > MIN_HEIGHT * Math.max(Math.hypot(u[0], u[1], u[2]), Math.hypot(v[0], v[1], v[2]), Math.hypot(w[0], w[1], w[2])) ? 1 : 0;
    if (real[t]) normals.set([n[0] / length, n[1] / length, n[2] / length], 3 * t);
  }
  const onEdge = new Map<number, number[]>();
  const vertices = P.length / 3;
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [I[3 * t + k], I[3 * t + ((k + 1) % 3)]];
      const key = a < b ? a * vertices + b : b * vertices + a;
      const ts = onEdge.get(key);
      if (ts) ts.push(t);
      else onEdge.set(key, [t]);
    }
  }
  for (const ts of onEdge.values()) {
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        const [t1, t2] = [ts[i], ts[j]];
        if (real[t1] && real[t2] && normals[3 * t1] * normals[3 * t2] + normals[3 * t1 + 1] * normals[3 * t2 + 1] + normals[3 * t1 + 2] * normals[3 * t2 + 2] < -FOLD_COS) return true;
      }
    }
  }
  return false;
}
