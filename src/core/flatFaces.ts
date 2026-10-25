import type { CoilMesh } from "./types";
import { NEEDLE_HEIGHT, WELD_EPSILON } from "./weld";

export const FLAT_FACE_MAX_EDGE = 10;

const PLANE_TOLERANCE = 0.01;

const MIN_GAIN = 1e-9;

const WORST_ANGLE_TO_FLIP = (2 * Math.PI) / 180;

const FOLD_COS = 0.99;

const MAX_TILT_COS = Math.cos(Math.PI / 180);

const COPLANAR = 1e-4;

function area2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function minAngle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const ab = Math.hypot(bx - ax, by - ay);
  const bc = Math.hypot(cx - bx, cy - by);
  const ca = Math.hypot(ax - cx, ay - cy);
  const twiceArea = Math.abs(area2(ax, ay, bx, by, cx, cy));
  if (twiceArea === 0) return 0;
  const sine = Math.min(twiceArea / (ab * ca), twiceArea / (ab * bc), twiceArea / (bc * ca));
  return Math.asin(Math.min(1, sine));
}

const HASH_PRIME_X = 73856093;
const HASH_PRIME_Y = 19349663;
const HASH_PRIME_Z = 83492791;
const MIN_TABLE_SIZE = 1024;
const NEGATIVE_ZERO_BITS = 0x80000000;
const FLIP_BUDGET_PER_EDGE = 20;
const FLIP_BUDGET_FLOOR = 1000;
const MAX_FAN_WALK = 10_000;
const UNSET = -1;

function triangleNeighbours(tr: Uint32Array): Int32Array {
  const nbr = new Int32Array(tr.length).fill(UNSET);
  let size = MIN_TABLE_SIZE;
  while (size < 4 * tr.length) size *= 2;
  const table = new Int32Array(size).fill(UNSET);
  const uses = new Uint8Array(size);
  const mask = size - 1;
  for (let slot = 0; slot < tr.length; slot++) {
    const t = (slot / 3) | 0;
    const a = tr[slot];
    const b = tr[3 * t + ((slot % 3) + 1) % 3];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    let h = (Math.imul(lo, HASH_PRIME_X) ^ Math.imul(hi, HASH_PRIME_Y)) & mask;
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
        if (uses[h] === 1 && oa === b && ob === a && ot !== t) {
          nbr[other] = t;
          nbr[slot] = ot;
        } else if (nbr[other] >= 0) {
          const partner = nbr[other];
          for (let k = 0; k < 3; k++) {
            const [pa, pb] = [tr[3 * partner + k], tr[3 * partner + ((k + 1) % 3)]];
            if (nbr[3 * partner + k] === ot && pa + pb === lo + hi && (pa === lo || pa === hi)) nbr[3 * partner + k] = UNSET;
          }
          nbr[other] = UNSET;
        }
        uses[h] = 2;
        break;
      }
    }
  }
  return nbr;
}

function markCoincidentVertices(pos: Float32Array, tr: Uint32Array, contact: Uint8Array): void {
  const used = new Uint8Array(contact.length);
  for (let i = 0; i < tr.length; i++) used[tr[i]] = 1;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  const word = (i: number) => (bits[i] === NEGATIVE_ZERO_BITS ? 0 : bits[i]);
  let tsize = MIN_TABLE_SIZE;
  while (tsize < 2 * contact.length) tsize *= 2;
  const slots = new Int32Array(tsize).fill(UNSET);
  for (let v = 0; v < contact.length; v++) {
    if (!used[v]) continue;
    const [x, y, z] = [word(3 * v), word(3 * v + 1), word(3 * v + 2)];
    let h = (Math.imul(x, HASH_PRIME_X) ^ Math.imul(y, HASH_PRIME_Y) ^ Math.imul(z, HASH_PRIME_Z)) & (tsize - 1);
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

function markFoldedEdges(tr: Uint32Array, nbr: Int32Array, normal: Float64Array, contact: Uint8Array): void {
  for (let slot = 0; slot < tr.length; slot++) {
    const [t, o] = [(slot / 3) | 0, nbr[slot]];
    if (o < t) continue;
    const dot = normal[3 * t] * normal[3 * o] + normal[3 * t + 1] * normal[3 * o + 1] + normal[3 * t + 2] * normal[3 * o + 2];
    if (dot >= 0) continue;
    const lens2 = (normal[3 * t] ** 2 + normal[3 * t + 1] ** 2 + normal[3 * t + 2] ** 2) * (normal[3 * o] ** 2 + normal[3 * o + 1] ** 2 + normal[3 * o + 2] ** 2);
    if (dot * dot > FOLD_COS * FOLD_COS * lens2) contact[tr[slot]] = contact[tr[3 * t + ((slot % 3) + 1) % 3]] = 1;
  }
}

function inPlaneAxisU(mx: number, my: number, mz: number): [number, number, number] {
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
  return [ux, uy, uz];
}

export function improveFlatFaces(mesh: CoilMesh, { horizontalOnly = false } = {}): CoilMesh {
  const pos = mesh.positions;
  const tr = new Uint32Array(mesh.indices);
  const triCount = tr.length / 3;

  const nbr = triangleNeighbours(tr);
  const contact = new Uint8Array(pos.length / 3);
  markCoincidentVertices(pos, tr, contact);

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
  markFoldedEdges(tr, nbr, normal, contact);

  const worst = new Float64Array(triCount);
  const setWorst = (t: number) => {
    const [a, b, c] = [3 * tr[3 * t], 3 * tr[3 * t + 1], 3 * tr[3 * t + 2]];
    const ab = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    const bc = Math.hypot(pos[c] - pos[b], pos[c + 1] - pos[b + 1], pos[c + 2] - pos[b + 2]);
    const ca = Math.hypot(pos[a] - pos[c], pos[a + 1] - pos[c + 1], pos[a + 2] - pos[c + 2]);
    const twiceArea = Math.hypot(normal[3 * t], normal[3 * t + 1], normal[3 * t + 2]);
    const shortest = Math.min(ab, bc, ca);
    worst[t] = Math.asin(Math.min(1, twiceArea / ((ab * bc * ca) / Math.max(shortest, 1e-300))));
  };
  for (let t = 0; t < triCount; t++) setWorst(t);

  const apex = (t: number, a: number, b: number) => {
    for (let e = 0; e < 3; e++) {
      const v = tr[3 * t + e];
      if (v !== a && v !== b) return v;
    }
    return a;
  };
  const joined = (t: number, a: number, b: number) => {
    let cur = t;
    for (let steps = 0; steps < MAX_FAN_WALK; steps++) {
      let k = 0;
      while (tr[3 * cur + k] !== a) k++;
      if (tr[3 * cur + ((k + 1) % 3)] === b || tr[3 * cur + ((k + 2) % 3)] === b) return true;
      cur = nbr[3 * cur + k];
      if (cur < 0) return true;
      if (cur === t) return false;
    }
    return true;
  };
  const retarget = (t: number, a: number, b: number, from: number, to: number) => {
    if (t < 0) return;
    for (let e = 0; e < 3; e++) {
      const [u, v] = [tr[3 * t + e], tr[3 * t + ((e + 1) % 3)]];
      if (nbr[3 * t + e] === from && ((u === a && v === b) || (u === b && v === a))) nbr[3 * t + e] = to;
    }
  };

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
  const foldsBack = (corners: number[], others: number[]) => {
    const n = realNormal(corners);
    return others.some((o) => o >= 0 && opposite(n, realNormal([tr[3 * o], tr[3 * o + 1], tr[3 * o + 2]])));
  };

  const stack: number[] = [];
  for (let t = 0; t < triCount; t++) for (let e = 0; e < 3; e++) if (nbr[3 * t + e] > t) stack.push(3 * t + e);
  let budget = FLIP_BUDGET_PER_EDGE * stack.length + FLIP_BUDGET_FLOOR;
  while (stack.length > 0 && budget-- > 0) {
    const code = stack.pop()!;
    const t1 = (code / 3) | 0;
    const e = code % 3;
    const t2 = nbr[code];
    if (t2 < 0 || Math.min(worst[t1], worst[t2]) >= WORST_ANGLE_TO_FLIP) continue;
    const p = tr[3 * t1 + e];
    const q = tr[3 * t1 + ((e + 1) % 3)];
    const c = tr[3 * t1 + ((e + 2) % 3)];
    const d = apex(t2, p, q);
    if (contact[p] || contact[q] || contact[c] || contact[d]) continue;

    if (horizontalOnly && (normal[3 * t1] !== 0 || normal[3 * t1 + 1] !== 0 || normal[3 * t2] !== 0 || normal[3 * t2 + 1] !== 0)) continue;

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

    const mx = nx / len;
    const my = ny / len;
    const mz = nz / len;
    const [ux, uy, uz] = inPlaneAxisU(mx, my, mz);
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

    if (area2(xp, yp, xq, yq, xc, yc) <= 0 || area2(xq, yq, xp, yp, xd, yd) <= 0) continue;
    if (area2(xp, yp, xd, yd, xc, yc) <= 0 || area2(xd, yd, xq, yq, xc, yc) <= 0) continue;
    const before = Math.min(minAngle(xp, yp, xq, yq, xc, yc), minAngle(xq, yq, xp, yp, xd, yd));
    if (before >= WORST_ANGLE_TO_FLIP) continue;
    const after = Math.min(minAngle(xp, yp, xd, yd, xc, yc), minAngle(xd, yd, xq, yq, xc, yc));
    if (after <= before + MIN_GAIN) continue;
    if ((pos[3 * c] - pos[3 * d]) ** 2 + (pos[3 * c + 1] - pos[3 * d + 1]) ** 2 + (pos[3 * c + 2] - pos[3 * d + 2]) ** 2 < WELD_EPSILON ** 2) continue;
    if (joined(t1, c, d)) continue;

    const acrossQC = nbr[3 * t1 + ((e + 1) % 3)];
    const acrossCP = nbr[3 * t1 + ((e + 2) % 3)];
    let acrossPD = UNSET;
    let acrossDQ = UNSET;
    for (let k = 0; k < 3; k++) {
      const [u, v] = [tr[3 * t2 + k], tr[3 * t2 + ((k + 1) % 3)]];
      if (u === p && v === d) acrossPD = nbr[3 * t2 + k];
      if (u === d && v === q) acrossDQ = nbr[3 * t2 + k];
    }
    if (Math.abs(offPlane) > COPLANAR && (tiltsAway([p, d, c], nx, ny, nz) || tiltsAway([d, q, c], nx, ny, nz))) continue;
    if (Math.abs(offPlane) > COPLANAR && (foldsBack([p, d, c], [acrossPD, acrossCP]) || foldsBack([d, q, c], [acrossDQ, acrossQC]) || foldsBetween([p, d, c], [d, q, c]))) continue;
    tr.set([p, d, c], 3 * t1);
    tr.set([d, q, c], 3 * t2);
    nbr.set([acrossPD, t2, acrossCP], 3 * t1);
    nbr.set([acrossDQ, acrossQC, t1], 3 * t2);
    retarget(acrossPD, p, d, t2, t1);
    retarget(acrossQC, q, c, t1, t2);
    setNormal(t1);
    setNormal(t2);
    setWorst(t1);
    setWorst(t2);
    stack.push(3 * t1, 3 * t1 + 2, 3 * t2, 3 * t2 + 1);
  }

  return { positions: mesh.positions, indices: tr };
}
