import * as THREE from "three";

const MAX_OUTLINE_VERTICES = 64;
const MIN_HEIGHT_MM = 1e-3;
const ANGULAR_BINS = 1024;
const ROUND_OUTSET_SAMPLES = 16;

type Outline = { xs: number[]; ys: number[] };

function turn(o: number, a: number, b: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  return (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
}

function outermostPerDirection(xs: Float64Array, ys: Float64Array): { xs: Float64Array; ys: Float64Array } {
  const n = xs.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i];
    cy += ys[i];
  }
  cx /= n;
  cy /= n;
  const best = new Int32Array(ANGULAR_BINS).fill(-1);
  const reach = new Float64Array(ANGULAR_BINS);
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    const bin = Math.min(ANGULAR_BINS - 1, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * ANGULAR_BINS));
    const r2 = dx * dx + dy * dy;
    if (best[bin] < 0 || r2 > reach[bin]) {
      best[bin] = i;
      reach[bin] = r2;
    }
  }
  const kept = Array.from(best).filter((i) => i >= 0);
  return { xs: Float64Array.from(kept, (i) => xs[i]), ys: Float64Array.from(kept, (i) => ys[i]) };
}

function convexHull(xs: Float64Array, ys: Float64Array): Outline {
  const order = Uint32Array.from({ length: xs.length }, (_, i) => i).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  const chain: number[] = [];
  const extend = (i: number, floor: number) => {
    while (chain.length >= floor && turn(chain[chain.length - 2], chain[chain.length - 1], i, xs, ys) <= 0) chain.pop();
    chain.push(i);
  };
  for (let k = 0; k < order.length; k++) extend(order[k], 2);
  const lowerSize = chain.length + 1;
  for (let k = order.length - 2; k >= 0; k--) extend(order[k], lowerSize);
  chain.pop();
  return { xs: chain.map((i) => xs[i]), ys: chain.map((i) => ys[i]) };
}

function decimate({ xs, ys }: Outline, maxVertices: number): Outline {
  while (xs.length > maxVertices) {
    const n = xs.length;
    let flattest = 0;
    let smallest = Infinity;
    for (let i = 0; i < n; i++) {
      const area = Math.abs(turn((i + n - 1) % n, i, (i + 1) % n, xs, ys));
      if (area < smallest) {
        smallest = area;
        flattest = i;
      }
    }
    xs.splice(flattest, 1);
    ys.splice(flattest, 1);
  }
  return { xs, ys };
}

function prism({ xs, ys }: Outline, zLo: number, zHi: number): THREE.BufferGeometry {
  const n = xs.length;
  const positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    positions.set([xs[i], ys[i], zLo], i * 3);
    positions.set([xs[i], ys[i], zHi], (n + i) * 3);
  }
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
    if (i >= 1 && i < n - 1) indices.push(n, n + i, n + i + 1, 0, i + 1, i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

function inflate({ xs, ys }: { xs: Float64Array; ys: Float64Array }, radius: number): { xs: Float64Array; ys: Float64Array } {
  const n = xs.length;
  const out = { xs: new Float64Array(n * ROUND_OUTSET_SAMPLES), ys: new Float64Array(n * ROUND_OUTSET_SAMPLES) };
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < ROUND_OUTSET_SAMPLES; k++) {
      const angle = (2 * Math.PI * k) / ROUND_OUTSET_SAMPLES;
      out.xs[i * ROUND_OUTSET_SAMPLES + k] = xs[i] + radius * Math.cos(angle);
      out.ys[i * ROUND_OUTSET_SAMPLES + k] = ys[i] + radius * Math.sin(angle);
    }
  }
  return out;
}

export function buildCableStandIn(paths: Float32Array[], wireRadius: number, rotation: THREE.Matrix4 | null): THREE.BufferGeometry | null {
  const pointCount = paths.reduce((n, path) => n + Math.floor(path.length / 3), 0);
  if (pointCount < 3) return null;
  const xs = new Float64Array(pointCount);
  const ys = new Float64Array(pointCount);
  let zLo = Infinity;
  let zHi = -Infinity;
  let at = 0;
  for (const path of paths) {
    for (let i = 0; i + 2 < path.length; i += 3, at++) {
      xs[at] = path[i];
      ys[at] = path[i + 1];
      zLo = Math.min(zLo, path[i + 2]);
      zHi = Math.max(zHi, path[i + 2]);
    }
  }
  const outermost = outermostPerDirection(xs, ys);
  const { xs: hullXs, ys: hullYs } = inflate(outermost, wireRadius / Math.cos(Math.PI / ROUND_OUTSET_SAMPLES));
  const outline = decimate(convexHull(hullXs, hullYs), MAX_OUTLINE_VERTICES);
  if (outline.xs.length < 3) return null;
  const geometry = prism(outline, zLo - wireRadius, Math.max(zHi + wireRadius, zLo - wireRadius + MIN_HEIGHT_MM));
  if (rotation) geometry.applyMatrix4(rotation);
  return geometry;
}
