// Welding of near-coincident vertices (issue #193).
//
// Where two faceted curved surfaces meet in a boolean (the bayonet's L-slot
// cutters against the cap's collar, the chamfer of its plate rim, the core's
// grooved wall), the intersection curve passes a few thousandths of a
// millimetre from vertices that are already there. A facet with such a short
// edge on its border has a needle on it whose third corner is millimetres away,
// and no edge flip can fix that, because the short edge is on the border. The
// line-art renderer draws needles as isolated pixels.
//
// This collapses every edge shorter than WELD_EPSILON onto one of its ends, as
// long as that keeps the mesh a closed manifold and folds no triangle over.
// Each collapse moves a vertex by less than the epsilon and drops two
// triangles. What the collapses leave behind is for flatFaces.ts to flip.

import type { CoilMesh } from "./types";

/**
 * Edges shorter than this (mm) are collapsed. Far below what a printer
 * resolves (0.05 mm at best) and above the 0.0055 mm gaps the booleans leave.
 */
export const WELD_EPSILON = 0.02;

/** A triangle may turn by at most this angle (cosine) when its corner moves. */
const MIN_NORMAL_COS = 0.2;

/**
 * `mesh` with its short edges collapsed, and for each triangle of the result
 * the index it had in `mesh` (so a caller can carry per-triangle marks over).
 * The input is not modified; when nothing collapses it is returned as is.
 */
export function weldShortEdges(mesh: CoilMesh, epsilon: number = WELD_EPSILON): { mesh: CoilMesh; origin: Uint32Array } {
  const pos = mesh.positions;
  const tr = new Uint32Array(mesh.indices);
  const triCount = tr.length / 3;
  const vertexCount = pos.length / 3;
  const squared = (a: number, b: number) => (pos[3 * a] - pos[3 * b]) ** 2 + (pos[3 * a + 1] - pos[3 * b + 1]) ** 2 + (pos[3 * a + 2] - pos[3 * b + 2]) ** 2;
  const limit = epsilon * epsilon;

  // The short edges, once each (a closed mesh runs every edge both ways), shortest first.
  const queueU: number[] = [];
  const queueV: number[] = [];
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = tr[3 * t + e];
      const b = tr[3 * t + ((e + 1) % 3)];
      if (a < b && squared(a, b) < limit) {
        queueU.push(a);
        queueV.push(b);
      }
    }
  }
  if (queueU.length === 0) return { mesh, origin: Uint32Array.from({ length: triCount }, (_, t) => t) };
  const byLength = Uint32Array.from({ length: queueU.length }, (_, i) => i).sort((i, j) => squared(queueU[i], queueV[i]) - squared(queueU[j], queueV[j]));
  const [sortedU, sortedV] = [Array.from(byLength, (i) => queueU[i]), Array.from(byLength, (i) => queueV[i])];
  queueU.length = 0;
  queueV.length = 0;
  queueU.push(...sortedU);
  queueV.push(...sortedV);

  // Triangles per vertex. A collapse hands a vertex's triangles to the other end, listed in `gained`.
  const start = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < tr.length; i++) start[tr[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) start[v + 1] += start[v];
  const fill = start.slice(0, vertexCount);
  const incident = new Uint32Array(tr.length);
  for (let t = 0; t < triCount; t++) for (let e = 0; e < 3; e++) incident[fill[tr[3 * t + e]]++] = t;
  const gained = new Map<number, number[]>();
  const alive = new Uint8Array(triCount).fill(1);
  const has = (t: number, v: number) => tr[3 * t] === v || tr[3 * t + 1] === v || tr[3 * t + 2] === v;
  const trianglesOf = (v: number): number[] => {
    const out: number[] = [];
    for (let i = start[v]; i < start[v + 1]; i++) if (alive[incident[i]] && has(incident[i], v)) out.push(incident[i]);
    for (const t of gained.get(v) ?? []) if (alive[t] && has(t, v)) out.push(t);
    return out;
  };
  const normalOf = (a: number, b: number, c: number): [number, number, number] => {
    const [ux, uy, uz] = [pos[3 * b] - pos[3 * a], pos[3 * b + 1] - pos[3 * a + 1], pos[3 * b + 2] - pos[3 * a + 2]];
    const [vx, vy, vz] = [pos[3 * c] - pos[3 * a], pos[3 * c + 1] - pos[3 * a + 1], pos[3 * c + 2] - pos[3 * a + 2]];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };

  const gone = new Uint8Array(vertexCount);
  let collapses = 0;
  // The queue grows as collapses leave their neighbours' edges short.
  for (let i = 0; i < queueU.length; i++) {
    // Move one end onto the other; try both ways.
    for (const [u, v] of [
      [queueU[i], queueV[i]],
      [queueV[i], queueU[i]],
    ]) {
      if (gone[u] || gone[v]) break;
      const ofU = trianglesOf(u);
      const ofV = trianglesOf(v);
      const onEdge = ofU.filter((t) => ofV.includes(t)); // the two triangles on the edge
      if (onEdge.length !== 2) continue;
      // Link condition: u and v share no neighbour but the two across the edge, or the collapse pinches the surface.
      const across = onEdge.map((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]].find((x) => x !== u && x !== v)!);
      const neighboursOfV = new Set<number>(ofV.flatMap((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]));
      const shared = new Set<number>(ofU.flatMap((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]).filter((x) => x !== u && x !== v && neighboursOfV.has(x)));
      if (across[0] === across[1] || shared.size !== 2) continue;
      // No triangle of u folds over when u moves onto v.
      let folds = false;
      for (const t of ofU) {
        if (onEdge.includes(t)) continue;
        const [a, b, c] = [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]];
        const before = normalOf(a, b, c);
        const after = normalOf(a === u ? v : a, b === u ? v : b, c === u ? v : c);
        const [lenBefore, lenAfter] = [Math.hypot(...before), Math.hypot(...after)];
        const along = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
        // A triangle thinner than the epsilon is itself a needle: its facing means nothing, and it may turn freely.
        const longest = Math.sqrt(Math.max(squared(a, b), squared(b, c), squared(c, a)));
        if (lenBefore > 2 * epsilon * longest && (lenAfter === 0 || along < MIN_NORMAL_COS * lenBefore * lenAfter)) folds = true;
      }
      if (folds) continue;
      for (const t of onEdge) alive[t] = 0;
      for (const t of ofU) {
        if (!alive[t]) continue;
        for (let e = 0; e < 3; e++) if (tr[3 * t + e] === u) tr[3 * t + e] = v;
        const list = gained.get(v);
        if (list) list.push(t);
        else gained.set(v, [t]);
        // The edges now meeting at v may be short.
        for (const w of [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]) {
          if (w !== v && squared(v, w) < limit) {
            queueU.push(v);
            queueV.push(w);
          }
        }
      }
      gone[u] = 1;
      collapses++;
      break;
    }
  }
  if (collapses === 0) return { mesh, origin: Uint32Array.from({ length: triCount }, (_, t) => t) };

  const kept = new Uint32Array(alive.reduce((n, a) => n + a, 0));
  const indices = new Uint32Array(3 * kept.length);
  let n = 0;
  for (let t = 0; t < triCount; t++) {
    if (!alive[t]) continue;
    kept[n] = t;
    indices.set(tr.subarray(3 * t, 3 * t + 3), 3 * n);
    n++;
  }
  return { mesh: { positions: mesh.positions, indices }, origin: kept };
}
