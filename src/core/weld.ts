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
//
// A collapse is safe when the link condition holds: the ends' only shared
// neighbours are the two vertices across the edge, or it would make a
// non-manifold edge. (It does let a closed piece smaller than the epsilon, a
// tetrahedron of no volume that the booleans leave, flatten into a
// double-sided triangle, which manifold-3d drops when it reads the mesh.)
// The pass repeats until no short edge is left or a round collapses none,
// and reports what it could not collapse (issue #208).

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
 * `stuck` counts the short edges left because no collapse of them is safe: on a
 * border or a non-manifold edge, failing the link condition, or folding a
 * triangle over (issue #208: 0 on every design the tests sample).
 * The input is not modified; when nothing collapses it is returned as is.
 */
export function weldShortEdges(mesh: CoilMesh, epsilon: number = WELD_EPSILON): { mesh: CoilMesh; origin: Uint32Array; stuck: number } {
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
  if (queueU.length === 0) return { mesh, origin: Uint32Array.from({ length: triCount }, (_, t) => t), stuck: 0 };
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
  /** Collapse u onto v if that is safe; whether it was. */
  const collapse = (u: number, v: number): boolean => {
    const ofU = trianglesOf(u);
    const ofV = trianglesOf(v);
    const onEdge = ofU.filter((t) => ofV.includes(t)); // the two triangles on the edge
    if (onEdge.length !== 2) return false; // a border or a non-manifold edge
    // Link condition: u and v share no neighbour but the two across the edge, or the collapse pinches the surface.
    const across = onEdge.map((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]].find((x) => x !== u && x !== v)!);
    const neighboursOfV = new Set<number>(ofV.flatMap((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]));
    const shared = new Set<number>(ofU.flatMap((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]).filter((x) => x !== u && x !== v && neighboursOfV.has(x)));
    if (across[0] === across[1] || shared.size !== 2) return false;
    // No triangle of u folds over when u moves onto v.
    for (const t of ofU) {
      if (onEdge.includes(t)) continue;
      const [a, b, c] = [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]];
      const before = normalOf(a, b, c);
      const after = normalOf(a === u ? v : a, b === u ? v : b, c === u ? v : c);
      const [lenBefore, lenAfter] = [Math.hypot(...before), Math.hypot(...after)];
      const along = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
      // A triangle thinner than the epsilon is itself a needle: its facing means nothing, and it may turn freely.
      const longest = Math.sqrt(Math.max(squared(a, b), squared(b, c), squared(c, a)));
      if (lenBefore > 2 * epsilon * longest && (lenAfter === 0 || along < MIN_NORMAL_COS * lenBefore * lenAfter)) return false;
    }
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
    return true;
  };

  /**
   * Where the booleans leave a cluster of near-coincident vertices, a short edge can fail the link condition because a
   * vertex across it has only three triangles: a tip, a hair above the triangle its three neighbours span, that is
   * joined to both ends of the edge and to one more vertex they share. Dropping the tip onto the nearer end of the
   * edge makes the edge collapsible. Only a tip within the epsilon of that triangle's plane is dropped, so the surface
   * moves by less than the epsilon (the tip itself may move further). Whether a tip was dropped.
   */
  const dropTip = (u: number, v: number): boolean => {
    const ofV = trianglesOf(v);
    for (const t of trianglesOf(u)) {
      if (!ofV.includes(t)) continue;
      const x = [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]].find((y) => y !== u && y !== v)!;
      const ofX = trianglesOf(x);
      if (ofX.length !== 3) continue;
      const w = ofX.flatMap((s) => [tr[3 * s], tr[3 * s + 1], tr[3 * s + 2]]).find((y) => y !== x && y !== u && y !== v);
      if (w === undefined) continue;
      const n = normalOf(u, v, w);
      const len = Math.hypot(...n);
      const height = len === 0 ? 0 : Math.abs((pos[3 * x] - pos[3 * u]) * n[0] + (pos[3 * x + 1] - pos[3 * u + 1]) * n[1] + (pos[3 * x + 2] - pos[3 * u + 2]) * n[2]) / len;
      const [near, far] = squared(x, u) < squared(x, v) ? [u, v] : [v, u];
      if (height < epsilon && (collapse(x, near) || collapse(x, far))) return true;
    }
    return false;
  };

  // The queue grows as collapses leave their neighbours' edges short. An edge
  // refused once may be safe after its neighbours collapse (issue #208), so
  // this goes over the short edges left until none is, or a round collapses
  // nothing.
  let collapses = 0;
  let stuck = 0;
  for (;;) {
    let round = 0;
    const [leftU, leftV]: [number[], number[]] = [[], []];
    for (let i = 0; i < queueU.length; i++) {
      const [u, v] = [queueU[i], queueV[i]];
      if (gone[u] || gone[v]) continue;
      // Move one end onto the other; try both ways.
      if (collapse(u, v) || collapse(v, u)) {
        round++;
        continue;
      }
      if (dropTip(u, v)) {
        round++;
        if (collapse(u, v) || collapse(v, u)) continue;
      }
      leftU.push(u);
      leftV.push(v);
    }
    collapses += round;
    // Every short edge a collapse makes is queued, so the ones refused are all that can be left.
    queueU.length = 0;
    queueV.length = 0;
    const left = new Set<number>();
    for (let i = 0; i < leftU.length; i++) {
      const [u, v] = [leftU[i], leftV[i]];
      if (gone[u] || gone[v] || left.has(Math.min(u, v) * vertexCount + Math.max(u, v))) continue;
      left.add(Math.min(u, v) * vertexCount + Math.max(u, v));
      queueU.push(u);
      queueV.push(v);
    }
    stuck = queueU.length;
    if (stuck === 0 || round === 0) break;
  }
  if (collapses === 0) return { mesh, origin: Uint32Array.from({ length: triCount }, (_, t) => t), stuck };

  const kept = new Uint32Array(alive.reduce((n, a) => n + a, 0));
  const indices = new Uint32Array(3 * kept.length);
  let n = 0;
  for (let t = 0; t < triCount; t++) {
    if (!alive[t]) continue;
    kept[n] = t;
    indices.set(tr.subarray(3 * t, 3 * t + 3), 3 * n);
    n++;
  }
  return { mesh: { positions: mesh.positions, indices }, origin: kept, stuck };
}
