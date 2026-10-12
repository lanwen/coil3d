import type { CoilMesh } from "./types";

export const WELD_EPSILON = 0.02;

const TIP_HEIGHT_EPSILONS = 2;
const NEEDLE_LENGTH_EPSILONS = 2;

const SLIDE_DEVIATION_DIVISOR = 2;

const MIN_NORMAL_COS = 0.2;

export const NEEDLE_HEIGHT = 1e-3;

const FOLD_COS = Math.cos((8 * Math.PI) / 180);

const TURN_COS = Math.cos(Math.PI / 180);

export function weldShortEdges(mesh: CoilMesh, epsilon: number = WELD_EPSILON): { mesh: CoilMesh; origin: Uint32Array; stuck: number } {
  let pos = mesh.positions;
  const tr = new Uint32Array(mesh.indices);
  const triCount = tr.length / 3;
  const vertexCount = pos.length / 3;
  const squared = (a: number, b: number) => (pos[3 * a] - pos[3 * b]) ** 2 + (pos[3 * a + 1] - pos[3 * b + 1]) ** 2 + (pos[3 * a + 2] - pos[3 * b + 2]) ** 2;
  const limit = epsilon * epsilon;

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

  const queueShortEdgesAt = (v: number, t: number) => {
    for (const w of [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]) {
      if (w !== v && squared(v, w) < limit) {
        queueU.push(v);
        queueV.push(w);
      }
    }
  };

  const gone = new Uint8Array(vertexCount);
  const collapse = (u: number, v: number, middle = false): boolean => {
    const ofU = trianglesOf(u);
    const ofV = trianglesOf(v);
    const onEdge = ofU.filter((t) => ofV.includes(t));
    const isBorderOrNonManifold = onEdge.length !== 2;
    if (isBorderOrNonManifold) return false;
    const mightBeVolumelessPiece = ofU.length === 2 && ofV.length === 2;
    if (mightBeVolumelessPiece) {
      const x = [tr[3 * onEdge[0]], tr[3 * onEdge[0] + 1], tr[3 * onEdge[0] + 2]].find((y) => y !== u && y !== v)!;
      if (trianglesOf(x).length === 2) {
        for (const t of onEdge) alive[t] = 0;
        for (const w of [u, v, x]) gone[w] = 1;
        return true;
      }
    }
    const across = onEdge.map((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]].find((x) => x !== u && x !== v)!);
    const neighboursOfV = new Set<number>(ofV.flatMap((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]));
    const shared = new Set<number>(ofU.flatMap((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]).filter((x) => x !== u && x !== v && neighboursOfV.has(x)));
    const breaksLinkCondition = across[0] === across[1] || shared.size !== 2;
    if (breaksLinkCondition) return false;
    const movers = middle ? [...ofU, ...ofV].filter((t) => !onEdge.includes(t)) : ofU.filter((t) => !onEdge.includes(t));
    const was = middle ? Array.from(pos.subarray(3 * v, 3 * v + 3)) : [];
    const longestOf = (a: number, b: number, c: number) => Math.sqrt(Math.max(squared(a, b), squared(b, c), squared(c, a)));
    const measure = (t: number) => {
      const [a, b, c] = [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]];
      return { n: normalOf(a, b, c), longest: longestOf(a, b, c) };
    };
    const before = new Map<number, ReturnType<typeof measure>>();
    if (middle) for (const t of movers) before.set(t, measure(t));
    if (middle) {
      if (pos === mesh.positions) pos = mesh.positions.slice();
      for (let k = 0; k < 3; k++) pos[3 * v + k] = (pos[3 * u + k] + was[k]) / 2;
    }
    const refuse = (): false => {
      if (middle) for (let k = 0; k < 3; k++) pos[3 * v + k] = was[k];
      return false;
    };
    const turned: number[] = [];
    for (const t of movers) {
      const [a, b, c] = [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]];
      const { n: nBefore, longest } = before.get(t) ?? measure(t);
      const nAfter = normalOf(a === u ? v : a, b === u ? v : b, c === u ? v : c);
      const [lenBefore, lenAfter] = [Math.hypot(...nBefore), Math.hypot(...nAfter)];
      const along = nBefore[0] * nAfter[0] + nBefore[1] * nAfter[1] + nBefore[2] * nAfter[2];
      if (lenBefore > NEEDLE_LENGTH_EPSILONS * epsilon * longest && (lenAfter === 0 || along < MIN_NORMAL_COS * lenBefore * lenAfter)) return refuse();
      if (lenBefore <= NEEDLE_HEIGHT * longest || !(along > TURN_COS * lenBefore * lenAfter)) turned.push(t);
    }
    const after = (t: number) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]].map((x) => (x === u ? v : x));
    const realNormal = (t: number): [number, number, number] | undefined => {
      const [a, b, c] = after(t);
      const n = normalOf(a, b, c);
      const longest = Math.sqrt(Math.max(squared(a, b), squared(b, c), squared(c, a)));
      return Math.hypot(...n) > NEEDLE_HEIGHT * longest ? n : undefined;
    };
    for (const t of movers) {
      const n = realNormal(t);
      if (!n) continue;
      const corners = after(t);
      for (let e = 0; e < 3; e++) {
        const [p, q] = [corners[e], corners[(e + 1) % 3]];
        for (const s of p === v ? [...ofU, ...ofV] : trianglesOf(p)) {
          if (s === t || onEdge.includes(s) || !after(s).includes(q)) continue;
          const m = realNormal(s);
          if (m && n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < -FOLD_COS * Math.hypot(...n) * Math.hypot(...m)) return refuse();
        }
      }
    }
    for (const t of onEdge) alive[t] = 0;
    for (const t of ofU) {
      if (!alive[t]) continue;
      for (let e = 0; e < 3; e++) if (tr[3 * t + e] === u) tr[3 * t + e] = v;
      const list = gained.get(v);
      if (list) list.push(t);
      else gained.set(v, [t]);
      queueShortEdgesAt(v, t);
    }
    if (middle) {
      for (const t of ofV) {
        if (alive[t]) queueShortEdgesAt(v, t);
      }
    }
    gone[u] = 1;
    return true;
  };

  const slideDeviation = (p: number, q: number): number => {
    let worst = 0;
    for (const t of trianglesOf(p)) {
      const [a, b, c] = [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]];
      if (a === q || b === q || c === q) continue;
      const n = normalOf(a, b, c);
      const len = Math.hypot(...n);
      if (len <= NEEDLE_HEIGHT * Math.sqrt(Math.max(squared(a, b), squared(b, c), squared(c, a)))) continue;
      const off = Math.abs((pos[3 * q] - pos[3 * p]) * n[0] + (pos[3 * q + 1] - pos[3 * p + 1]) * n[1] + (pos[3 * q + 2] - pos[3 * p + 2]) * n[2]) / len;
      worst = Math.max(worst, off);
    }
    return worst;
  };

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
      if (height < TIP_HEIGHT_EPSILONS * epsilon && (collapse(x, near) || collapse(x, far))) return true;
    }
    return false;
  };

  const slide = (u: number, v: number): boolean => {
    const reach: Array<[number, number]> = [];
    for (const [p, other] of [[u, v], [v, u]]) {
      const neighbours = new Set<number>(trianglesOf(p).flatMap((t) => [tr[3 * t], tr[3 * t + 1], tr[3 * t + 2]]));
      for (const q of neighbours) if (q !== p && q !== other) reach.push([p, q]);
    }
    reach.sort(([a, b], [c, d]) => squared(a, b) - squared(c, d));
    for (const [p, q] of reach) {
      if (slideDeviation(p, q) <= epsilon / SLIDE_DEVIATION_DIVISOR && collapse(p, q)) return true;
    }
    return false;
  };

  let collapses = 0;
  let stuck = 0;
  for (;;) {
    let round = 0;
    const [leftU, leftV]: [number[], number[]] = [[], []];
    for (let i = 0; i < queueU.length; i++) {
      const [u, v] = [queueU[i], queueV[i]];
      if (gone[u] || gone[v]) continue;
      if (collapse(u, v) || collapse(v, u)) {
        round++;
        continue;
      }
      if (dropTip(u, v)) {
        round++;
        if (collapse(u, v) || collapse(v, u)) continue;
      }
      if (collapse(u, v, true)) {
        round++;
        continue;
      }
      if (slide(u, v)) {
        round++;
        continue;
      }
      leftU.push(u);
      leftV.push(v);
    }
    collapses += round;
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
  return { mesh: { positions: pos, indices }, origin: kept, stuck };
}
