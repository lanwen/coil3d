// Better triangulation of a mesh's flat faces (issues #180 and #193).
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
// to. Then this flips an edge between two triangles that lie in one plane
// (within PLANE_TOLERANCE) whenever that raises the smaller of the two
// triangles' minimum angles (a Delaunay-style flip, done in that plane). Only
// such edges are touched, so the vertices and the triangle count never change
// in this step, and no vertex moves by more than the tolerance.
//
// The planes are any, not just horizontal ones (issue #193): where a curved wall of the
// collar is cut by another curved surface, the intersection runs a few
// micrometres off the wall's facets and leaves a strip of micro-triangles
// along the seam. Their normals point 45 degrees away from the wall's, and
// where one lands on a pixel the line-art renderer draws a dot.

import type { CoilMesh } from "./types";
import { NEEDLE_HEIGHT, WELD_EPSILON } from "./weld";

/**
 * The longest edge the call sites keep, mm. Measured on the round cap in the
 * print layout (27 views, 2x pixel density): flips alone leave 24 stray dots,
 * 25 mm leaves 21, 15 mm 8, 10 mm 2, 6 mm 5, 3 mm 10 and 2 mm 1, against 107
 * with no pass. Below 10 mm the count is noise, but the triangles are not: the
 * cap has 9.3k at 10 mm and 30k at 2 mm.
 */
export const FLAT_FACE_MAX_EDGE = 10;

/**
 * Two triangles count as one plane when the corner of one that is off the
 * shared edge lies this close (mm) to the plane of the larger. The seams above
 * sit 0.005 mm off; neighbouring facets of the collar's wall (0.3 mm wide,
 * 0.77 degrees apart) sit 0.004 mm off, which a flip across them may also use.
 * A flip never moves a vertex, but it swaps which diagonal the surface follows,
 * so the surface changes by at most this much.
 */
export const PLANE_TOLERANCE = 0.01;

/** A flip must beat the current worst angle by this much (radians), so cocircular quads never flip back and forth. */
const MIN_GAIN = 1e-9;

/**
 * Only a pair with a triangle that has an angle under this is worth a flip. The collar's wall is a skin of
 * columns 0.06 mm wide: 3 degrees at best, and thousands of flips for nothing if every one counted.
 */
const WORST_ANGLE_TO_FLIP = (2 * Math.PI) / 180;

/** Two triangles on an edge fold back onto each other when their normals are this close to opposite (cosine; 8 degrees). */
const FOLD_COS = 0.99;

const MAX_TILT_COS = Math.cos(Math.PI / 180);

/** A quad whose fourth corner is this close (mm) to the other three's plane is flat: a flip in it turns no triangle. */
const COPLANAR = 1e-4;

/** Twice the signed area of (a, b, c) in the (u, v) frame. */
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

/**
 * `mesh` with the edges between coplanar triangles flipped to the
 * triangulation that maximises the smallest angle; with `horizontalOnly`, only
 * those in a horizontal plane. The input is not
 * modified. (Typed arrays throughout: this runs on every design, and the
 * garbage of a plain-array version showed in the memory test.)
 */
export function improveFlatFaces(mesh: CoilMesh, { horizontalOnly = false } = {}): CoilMesh {
  const pos = mesh.positions;
  const tr = new Uint32Array(mesh.indices);
  const triCount = tr.length / 3;

  // The triangle across each edge (edge e of triangle t runs from corner e to
  // corner e+1), or -1: an open-addressing table of edges. Only an edge with
  // exactly two triangles, running it in opposite directions, gets a
  // neighbour; a border or non-manifold edge stays -1 and is never flipped.
  const nbr = new Int32Array(tr.length).fill(-1);
  let size = 1024;
  while (size < 4 * tr.length) size *= 2;
  const table = new Int32Array(size).fill(-1);
  const uses = new Uint8Array(size);
  const mask = size - 1;
  for (let slot = 0; slot < tr.length; slot++) {
    const t = (slot / 3) | 0;
    const a = tr[slot];
    const b = tr[3 * t + ((slot % 3) + 1) % 3];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    let h = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) & mask;
    for (; ; h = (h + 1) & mask) {
      const other = table[h];
      if (other < 0) {
        table[h] = slot;
        uses[h] = 1;
        break;
      }
      const ot = (other / 3) | 0;
      const oa = tr[other];
      const ob = tr[3 * ot + ((other % 3) + 1) % 3];
      if ((oa === lo && ob === hi) || (oa === hi && ob === lo)) {
        // The second triangle on the edge, running it the other way (the same way, they would face apart).
        if (uses[h] === 1 && oa === b && ob === a && ot !== t) {
          nbr[other] = t;
          nbr[slot] = ot;
        } else if (nbr[other] >= 0) {
          // A third: the edge is non-manifold, so undo the pair.
          const partner = nbr[other];
          for (let k = 0; k < 3; k++) {
            const [pa, pb] = [tr[3 * partner + k], tr[3 * partner + ((k + 1) % 3)]];
            if (nbr[3 * partner + k] === ot && pa + pb === lo + hi && (pa === lo || pa === hi)) nbr[3 * partner + k] = -1;
          }
          nbr[other] = -1;
        }
        uses[h] = 2;
        break;
      }
    }
  }

  // Where the booleans left the surface touching itself: vertices that share their position with another one (a
  // zero-width slit), and below, the ends of an edge where the surface folds back onto itself (two sheets of one
  // plane, facing apart). Flips there can close off a sheet of no volume, which manifold-3d then cuts off the part
  // when it reads the mesh back (issue #208), so the triangles around them stay as they are.
  const contact = new Uint8Array(pos.length / 3);
  {
    // Only the vertices in use: weld.ts leaves the ones it collapsed in the list.
    const used = new Uint8Array(contact.length);
    for (let i = 0; i < tr.length; i++) used[tr[i]] = 1;
    const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
    const word = (i: number) => (bits[i] === 0x80000000 ? 0 : bits[i]); // -0 is 0
    let tsize = 1024;
    while (tsize < 2 * contact.length) tsize *= 2;
    const slots = new Int32Array(tsize).fill(-1);
    for (let v = 0; v < contact.length; v++) {
      if (!used[v]) continue;
      const [x, y, z] = [word(3 * v), word(3 * v + 1), word(3 * v + 2)];
      let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (tsize - 1);
      for (; ; h = (h + 1) & (tsize - 1)) {
        const o = slots[h];
        if (o < 0) {
          slots[h] = v;
          break;
        }
        if (word(3 * o) === x && word(3 * o + 1) === y && word(3 * o + 2) === z) {
          contact[o] = contact[v] = 1;
          break;
        }
      }
    }
  }

  // The (non-unit) normal of a triangle: its twice-area is its length.
  const normal = new Float64Array(3 * triCount);
  const setNormal = (t: number) => {
    const a = 3 * tr[3 * t];
    const b = 3 * tr[3 * t + 1];
    const c = 3 * tr[3 * t + 2];
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    normal[3 * t] = uy * vz - uz * vy;
    normal[3 * t + 1] = uz * vx - ux * vz;
    normal[3 * t + 2] = ux * vy - uy * vx;
  };
  for (let t = 0; t < triCount; t++) setNormal(t);
  for (let slot = 0; slot < tr.length; slot++) {
    const [t, o] = [(slot / 3) | 0, nbr[slot]];
    if (o < t) continue;
    const dot = normal[3 * t] * normal[3 * o] + normal[3 * t + 1] * normal[3 * o + 1] + normal[3 * t + 2] * normal[3 * o + 2];
    if (dot >= 0) continue;
    const lens2 = (normal[3 * t] ** 2 + normal[3 * t + 1] ** 2 + normal[3 * t + 2] ** 2) * (normal[3 * o] ** 2 + normal[3 * o + 1] ** 2 + normal[3 * o + 2] ** 2);
    if (dot * dot > FOLD_COS * FOLD_COS * lens2) contact[tr[slot]] = contact[tr[3 * t + ((slot % 3) + 1) % 3]] = 1;
  }

  // The smallest angle of each triangle, from its 3D sides: an edge whose two triangles are both fine is skipped without any geometry.
  const worst = new Float64Array(triCount);
  const setWorst = (t: number) => {
    const [a, b, c] = [3 * tr[3 * t], 3 * tr[3 * t + 1], 3 * tr[3 * t + 2]];
    const ab = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    const bc = Math.hypot(pos[c] - pos[b], pos[c + 1] - pos[b + 1], pos[c + 2] - pos[b + 2]);
    const ca = Math.hypot(pos[a] - pos[c], pos[a + 1] - pos[c + 1], pos[a + 2] - pos[c + 2]);
    const twiceArea = Math.hypot(normal[3 * t], normal[3 * t + 1], normal[3 * t + 2]);
    // The smallest angle is opposite the shortest side, between the two longer ones.
    const shortest = Math.min(ab, bc, ca);
    worst[t] = Math.asin(Math.min(1, twiceArea / ((ab * bc * ca) / Math.max(shortest, 1e-300))));
  };
  for (let t = 0; t < triCount; t++) setWorst(t);

  /** The corner of triangle t that is not a or b. */
  const apex = (t: number, a: number, b: number) => {
    for (let e = 0; e < 3; e++) {
      const v = tr[3 * t + e];
      if (v !== a && v !== b) return v;
    }
    return a;
  };
  /**
   * Whether `a` and `b` share an edge, walking the triangles around `a` from `t` (one of them). A walk that runs into a
   * border or a non-manifold edge, where the fan is not a closed ring, answers yes: then the flip is not made.
   */
  const joined = (t: number, a: number, b: number) => {
    let cur = t;
    for (let steps = 0; steps < 10_000; steps++) {
      let k = 0;
      while (tr[3 * cur + k] !== a) k++;
      if (tr[3 * cur + ((k + 1) % 3)] === b || tr[3 * cur + ((k + 2) % 3)] === b) return true;
      cur = nbr[3 * cur + k];
      if (cur < 0) return true;
      if (cur === t) return false;
    }
    return true;
  };
  /** Point triangle `t`'s neighbour entry that is across the edge between `a` and `b`, and now points at `from`, at `to` instead. */
  const retarget = (t: number, a: number, b: number, from: number, to: number) => {
    if (t < 0) return;
    for (let e = 0; e < 3; e++) {
      const [u, v] = [tr[3 * t + e], tr[3 * t + ((e + 1) % 3)]];
      if (nbr[3 * t + e] === from && ((u === a && v === b) || (u === b && v === a))) nbr[3 * t + e] = to;
    }
  };

  /** The normal of the triangle on corners a, b, c, or undefined for a needle under NEEDLE_HEIGHT high, whose facing means nothing. */
  const realNormal = ([a, b, c]: number[]): [number, number, number] | undefined => {
    const [ux, uy, uz] = [pos[3 * b] - pos[3 * a], pos[3 * b + 1] - pos[3 * a + 1], pos[3 * b + 2] - pos[3 * a + 2]];
    const [vx, vy, vz] = [pos[3 * c] - pos[3 * a], pos[3 * c + 1] - pos[3 * a + 1], pos[3 * c + 2] - pos[3 * a + 2]];
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const longest = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(pos[3 * c] - pos[3 * b], pos[3 * c + 1] - pos[3 * b + 1], pos[3 * c + 2] - pos[3 * b + 2]));
    return Math.hypot(...n) > NEEDLE_HEIGHT * longest ? n : undefined;
  };
  const opposite = (n: [number, number, number] | undefined, m: [number, number, number] | undefined) =>
    n !== undefined && m !== undefined && n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < -FOLD_COS * Math.hypot(...n) * Math.hypot(...m);
  const tiltsAway = (corners: number[], nx: number, ny: number, nz: number) => {
    const n = realNormal(corners);
    return n !== undefined && n[0] * nx + n[1] * ny + n[2] * nz < MAX_TILT_COS * Math.hypot(...n) * Math.hypot(nx, ny, nz);
  };
  const foldsBetween = (a: number[], b: number[]) => opposite(realNormal(a), realNormal(b));
  /** Whether the triangle on `corners` would fold back over any of the triangles in `others` (-1 for a border: none). */
  const foldsBack = (corners: number[], others: number[]) => {
    const n = realNormal(corners);
    return others.some((o) => o >= 0 && opposite(n, realNormal([tr[3 * o], tr[3 * o + 1], tr[3 * o + 2]])));
  };

  // Each entry is triangle * 3 + edge. Each flip strictly raises the worst
  // angle of its quad, so this ends; the budget guards a pathological mesh.
  const stack: number[] = [];
  for (let t = 0; t < triCount; t++) for (let e = 0; e < 3; e++) if (nbr[3 * t + e] > t) stack.push(3 * t + e);
  let budget = 20 * stack.length + 1000;
  while (stack.length > 0 && budget-- > 0) {
    const code = stack.pop()!;
    const t1 = (code / 3) | 0;
    const e = code % 3;
    const t2 = nbr[code];
    if (t2 < 0 || Math.min(worst[t1], worst[t2]) >= WORST_ANGLE_TO_FLIP) continue;
    // t1 = (p, q, c) and t2 = (q, p, d) share p-q; the flip gives (p, d, c) and (d, q, c).
    const p = tr[3 * t1 + e];
    const q = tr[3 * t1 + ((e + 1) % 3)];
    const c = tr[3 * t1 + ((e + 2) % 3)];
    const d = apex(t2, p, q);
    if (contact[p] || contact[q] || contact[c] || contact[d]) continue;

    if (horizontalOnly && (normal[3 * t1] !== 0 || normal[3 * t1 + 1] !== 0 || normal[3 * t2] !== 0 || normal[3 * t2 + 1] !== 0)) continue;

    // The plane is the larger triangle's; the other one's far corner has to be near it.
    const nx1 = normal[3 * t1];
    const ny1 = normal[3 * t1 + 1];
    const nz1 = normal[3 * t1 + 2];
    const nx2 = normal[3 * t2];
    const ny2 = normal[3 * t2 + 1];
    const nz2 = normal[3 * t2 + 2];
    const len1 = Math.hypot(nx1, ny1, nz1);
    const len2 = Math.hypot(nx2, ny2, nz2);
    const nx = len1 >= len2 ? nx1 : nx2;
    const ny = len1 >= len2 ? ny1 : ny2;
    const nz = len1 >= len2 ? nz1 : nz2;
    const len = Math.max(len1, len2);
    if (len === 0) continue;
    const off = len1 >= len2 ? d : c;
    const offPlane = ((pos[3 * off] - pos[3 * p]) * nx + (pos[3 * off + 1] - pos[3 * p + 1]) * ny + (pos[3 * off + 2] - pos[3 * p + 2]) * nz) / len;
    if (Math.abs(offPlane) > PLANE_TOLERANCE) continue;

    // The 2D frame of that plane: u and v span it, u x v is the larger triangle's normal.
    const mx = nx / len;
    const my = ny / len;
    const mz = nz / len;
    // u: the normal crossed with the axis it is least aligned with.
    let ux: number;
    let uy: number;
    let uz: number;
    if (Math.abs(mx) <= Math.abs(my) && Math.abs(mx) <= Math.abs(mz)) [ux, uy, uz] = [0, mz, -my];
    else if (Math.abs(my) <= Math.abs(mz)) [ux, uy, uz] = [-mz, 0, mx];
    else [ux, uy, uz] = [my, -mx, 0];
    const ulen = Math.hypot(ux, uy, uz);
    ux /= ulen;
    uy /= ulen;
    uz /= ulen;
    const vx = my * uz - mz * uy;
    const vy = mz * ux - mx * uz;
    const vz = mx * uy - my * ux;
    const xp = ux * pos[3 * p] + uy * pos[3 * p + 1] + uz * pos[3 * p + 2];
    const yp = vx * pos[3 * p] + vy * pos[3 * p + 1] + vz * pos[3 * p + 2];
    const xq = ux * pos[3 * q] + uy * pos[3 * q + 1] + uz * pos[3 * q + 2];
    const yq = vx * pos[3 * q] + vy * pos[3 * q + 1] + vz * pos[3 * q + 2];
    const xc = ux * pos[3 * c] + uy * pos[3 * c + 1] + uz * pos[3 * c + 2];
    const yc = vx * pos[3 * c] + vy * pos[3 * c + 1] + vz * pos[3 * c + 2];
    const xd = ux * pos[3 * d] + uy * pos[3 * d + 1] + uz * pos[3 * d + 2];
    const yd = vx * pos[3 * d] + vy * pos[3 * d + 1] + vz * pos[3 * d + 2];

    // Both triangles face the larger one's way, and the new pair strictly does too: the quad must be convex. A flip
    // across a corner that is even a hair reflex leaves an inverted triangle, and that can cut the part into pieces
    // (issue #201: the bayonet cap at a few core sizes).
    // Issue #208: the old pair strictly as well. A flip across a triangle with no area (three points on a line)
    // reorders a zero-width slit, which manifold-3d can then cut off the part.
    if (area2(xp, yp, xq, yq, xc, yc) <= 0 || area2(xq, yq, xp, yp, xd, yd) <= 0) continue;
    if (area2(xp, yp, xd, yd, xc, yc) <= 0 || area2(xd, yd, xq, yq, xc, yc) <= 0) continue;
    const before = Math.min(minAngle(xp, yp, xq, yq, xc, yc), minAngle(xq, yq, xp, yp, xd, yd));
    if (before >= WORST_ANGLE_TO_FLIP) continue;
    const after = Math.min(minAngle(xp, yp, xd, yd, xc, yc), minAngle(xd, yd, xq, yq, xc, yc));
    if (after <= before + MIN_GAIN) continue;
    // The new edge must be at least as long as the weld's limit (or it puts back the near-coincident vertices weld.ts
    // removed), and must not be there already (it would have four triangles, and pinch the surface).
    if ((pos[3 * c] - pos[3 * d]) ** 2 + (pos[3 * c + 1] - pos[3 * d + 1]) ** 2 + (pos[3 * c + 2] - pos[3 * d + 2]) ** 2 < WELD_EPSILON ** 2) continue;
    if (joined(t1, c, d)) continue;

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
    if (Math.abs(offPlane) > COPLANAR && (tiltsAway([p, d, c], nx, ny, nz) || tiltsAway([d, q, c], nx, ny, nz))) continue;
    // Issue #219: and in 3D, where a corner sits off the plane (up to PLANE_TOLERANCE), neither new triangle may lie
    // back over the other or a neighbour: a fold of no thickness. (Four corners in one plane can't make a new one.)
    if (Math.abs(offPlane) > COPLANAR && (foldsBack([p, d, c], [C, B]) || foldsBack([d, q, c], [D, A]) || foldsBetween([p, d, c], [d, q, c]))) continue;
    tr.set([p, d, c], 3 * t1);
    tr.set([d, q, c], 3 * t2);
    nbr.set([C, t2, B], 3 * t1); // p->d, d->c, c->p
    nbr.set([D, A, t1], 3 * t2); // d->q, q->c, c->d
    retarget(C, p, d, t2, t1);
    retarget(A, q, c, t1, t2);
    setNormal(t1);
    setNormal(t2);
    setWorst(t1);
    setWorst(t2);
    stack.push(3 * t1, 3 * t1 + 2, 3 * t2, 3 * t2 + 1);
  }

  return { positions: mesh.positions, indices: tr };
}
