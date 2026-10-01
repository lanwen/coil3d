// Better triangulation of a mesh's horizontal flat faces (issue #180).
//
// After the booleans, a flat face with cut-outs in it (the top cap's
// underside around the collar and the cable clips, its top face under the
// engraved label) comes out of manifold-3d as a few huge triangles fanned
// out to dense runs of nearby vertices: needles 10-40 mm long and a
// thousandth of a millimetre wide. They are valid and exactly coplanar with
// their neighbours, but the line-art renderer samples them as isolated
// pixels -- a dotted line on the plate.
//
// Two steps. First `refineToLength`, at the call site, cuts the edges longer
// than FLAT_FACE_MAX_EDGE: the flips below can only choose among the vertices a
// face has, and a fan's spokes are one long edge each, with no vertex to flip
// to. Then this flips an edge between two triangles of the same horizontal plane
// whenever that raises the smaller of the two triangles' minimum angles (a
// Delaunay-style flip). Only such edges are touched, so the shape, the
// vertices and the triangle count never change in this step. Horizontal planes
// are what the print layouts' faces are: every part prints on one.

import type { CoilMesh } from "./types";

/**
 * The longest edge the call sites keep, mm. Measured on the round cap in the
 * print layout (27 views, 2x pixel density): flips alone leave 24 stray dots,
 * 25 mm leaves 21, 15 mm 8, 10 mm 2, 6 mm 5, 3 mm 10 and 2 mm 1, against 107
 * with no pass. Below 10 mm the count is noise, but the triangles are not: the
 * cap has 9.3k at 10 mm and 30k at 2 mm.
 */
export const FLAT_FACE_MAX_EDGE = 10;

/** Twice the signed area of (a, b, c) seen from +z. */
function area2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** The smallest angle of the triangle (a, b, c), radians (0 for a degenerate one). */
function minAngle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const ab = Math.hypot(bx - ax, by - ay);
  const bc = Math.hypot(cx - bx, cy - by);
  const ca = Math.hypot(ax - cx, ay - cy);
  const twiceArea = Math.abs(area2(ax, ay, bx, by, cx, cy));
  if (twiceArea === 0) return 0;
  // The sine of the angle at each vertex is twice the area over the product of the two sides meeting there.
  const sine = Math.min(twiceArea / (ab * ca), twiceArea / (ab * bc), twiceArea / (bc * ca));
  // The smallest angle is acute and has the smallest sine, so asin of that sine gives it.
  return Math.asin(Math.min(1, sine));
}

/** A flip must beat the current worst angle by this much (radians), so cocircular quads never flip back and forth. */
const MIN_GAIN = 1e-9;

/**
 * `mesh` with the edges between horizontal, coplanar triangles flipped to
 * the triangulation that maximises the smallest angle. The input is not
 * modified. (Typed arrays throughout: this runs on every design, and the
 * garbage of a plain-array version showed in the memory test.)
 */
export function improveFlatFaces(mesh: CoilMesh): CoilMesh {
  const pos = mesh.positions;
  const tr = new Uint32Array(mesh.indices);
  const triCount = tr.length / 3;
  const x = (v: number) => pos[3 * v];
  const y = (v: number) => pos[3 * v + 1];
  const z = (v: number) => pos[3 * v + 2];

  // The horizontal triangles, and for each edge of one (edge e runs from
  // corner e to corner e+1) the triangle across it, or -1 when that is not a
  // horizontal triangle sharing just that edge.
  const flat: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (z(tr[3 * t]) === z(tr[3 * t + 1]) && z(tr[3 * t]) === z(tr[3 * t + 2])) flat.push(t);
  }
  const nbr = new Int32Array(tr.length).fill(-1);
  const vertexCount = pos.length / 3;
  const edgeKey = new Float64Array(flat.length * 3);
  const order = new Uint32Array(flat.length * 3);
  for (let i = 0; i < flat.length; i++) {
    const t = flat[i];
    for (let e = 0; e < 3; e++) {
      const a = tr[3 * t + e];
      const b = tr[3 * t + ((e + 1) % 3)];
      edgeKey[3 * i + e] = a < b ? a * vertexCount + b : b * vertexCount + a;
      order[3 * i + e] = 3 * i + e;
    }
  }
  order.sort((u, v) => edgeKey[u] - edgeKey[v]);
  for (let k = 0; k < order.length; ) {
    let end = k + 1;
    while (end < order.length && edgeKey[order[end]] === edgeKey[order[k]]) end++;
    if (end - k === 2) {
      const [u, v] = [order[k], order[k + 1]];
      const [tu, tv] = [flat[(u / 3) | 0], flat[(v / 3) | 0]];
      nbr[3 * tu + (u % 3)] = tv;
      nbr[3 * tv + (v % 3)] = tu;
    }
    k = end;
  }

  /** The corner of triangle t that is not a or b. */
  const apex = (t: number, a: number, b: number) => {
    for (let e = 0; e < 3; e++) {
      const v = tr[3 * t + e];
      if (v !== a && v !== b) return v;
    }
    return a;
  };
  /** Point triangle `t`'s neighbour entry that is across the edge between `a` and `b`, and now points at `from`, at `to` instead. */
  const retarget = (t: number, a: number, b: number, from: number, to: number) => {
    if (t < 0) return;
    for (let e = 0; e < 3; e++) {
      const [u, v] = [tr[3 * t + e], tr[3 * t + ((e + 1) % 3)]];
      if (nbr[3 * t + e] === from && ((u === a && v === b) || (u === b && v === a))) nbr[3 * t + e] = to;
    }
  };

  // Each entry is triangle * 3 + edge. Each flip strictly raises the worst
  // angle of its quad, so this ends; the budget guards a pathological mesh.
  const stack: number[] = [];
  for (const t of flat) for (let e = 0; e < 3; e++) if (nbr[3 * t + e] >= 0) stack.push(3 * t + e);
  let budget = 20 * stack.length + 1000;
  while (stack.length > 0 && budget-- > 0) {
    const code = stack.pop()!;
    const t1 = (code / 3) | 0;
    const e = code % 3;
    const t2 = nbr[code];
    if (t2 < 0) continue;
    // t1 = (p, q, c) and t2 = (q, p, d) share p-q; the flip gives (p, d, c) and (d, q, c).
    const p = tr[3 * t1 + e];
    const q = tr[3 * t1 + ((e + 1) % 3)];
    const c = tr[3 * t1 + ((e + 2) % 3)];
    const d = apex(t2, p, q);
    const o1 = area2(x(p), y(p), x(q), y(q), x(c), y(c));
    const o2 = area2(x(q), y(q), x(p), y(p), x(d), y(d));
    const facing = Math.sign(Math.abs(o1) >= Math.abs(o2) ? o1 : o2);
    if (facing === 0 || area2(x(p), y(p), x(d), y(d), x(c), y(c)) * facing <= 0 || area2(x(d), y(d), x(q), y(q), x(c), y(c)) * facing <= 0) continue; // not a strictly convex quad
    const before = Math.min(minAngle(x(p), y(p), x(q), y(q), x(c), y(c)), minAngle(x(q), y(q), x(p), y(p), x(d), y(d)));
    const after = Math.min(minAngle(x(p), y(p), x(d), y(d), x(c), y(c)), minAngle(x(d), y(d), x(q), y(q), x(c), y(c)));
    if (after <= before + MIN_GAIN) continue;

    // The four outer neighbours: t1 has B across c-p and A across q-c; t2 has C across p-d and D across d-q.
    const A = nbr[3 * t1 + ((e + 1) % 3)];
    const B = nbr[3 * t1 + ((e + 2) % 3)];
    let C = -1;
    let D = -1;
    for (let k = 0; k < 3; k++) {
      const [u, v] = [tr[3 * t2 + k], tr[3 * t2 + ((k + 1) % 3)]];
      if (u === p && v === d) C = nbr[3 * t2 + k];
      if (u === d && v === q) D = nbr[3 * t2 + k];
    }
    tr.set([p, d, c], 3 * t1);
    tr.set([d, q, c], 3 * t2);
    nbr.set([C, t2, B], 3 * t1); // p->d, d->c, c->p
    nbr.set([D, A, t1], 3 * t2); // d->q, q->c, c->d
    retarget(C, p, d, t2, t1);
    retarget(A, q, c, t1, t2);
    stack.push(3 * t1, 3 * t1 + 2, 3 * t2, 3 * t2 + 1);
  }

  return { positions: mesh.positions, indices: tr };
}
