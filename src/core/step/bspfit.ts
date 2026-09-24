// Tensor-product cubic B-spline interpolation, periodic (uniform) in U,
// clamped (uniform) in V with analytic end tangents. Pure math, kernel
// agnostic: returns poles + knot data ready for OpenCascade's
// `Geom_BSplineSurface`. Ported from the S2 spike
// (spikes/s2-step-export/lib/bspfit.mjs), proven there against replicad.

export type Vec3 = [number, number, number];

function luFactor(A: Float64Array, n: number): (b: Float64Array) => Float64Array {
  const piv = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let p = k;
    let m = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i * n + k]);
      if (v > m) {
        m = v;
        p = i;
      }
    }
    piv[k] = p;
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = A[k * n + j];
        A[k * n + j] = A[p * n + j];
        A[p * n + j] = t;
      }
    }
    const d = A[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = (A[i * n + k] /= d);
      if (f !== 0) {
        for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      }
    }
  }
  return (b: Float64Array): Float64Array => {
    for (let k = 0; k < n; k++) {
      const p = piv[k];
      if (p !== k) {
        const t = b[k];
        b[k] = b[p];
        b[p] = t;
      }
    }
    for (let i = 1; i < n; i++) {
      let s = b[i];
      for (let j = 0; j < i; j++) s -= A[i * n + j] * b[j];
      b[i] = s;
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let j = i + 1; j < n; j++) s -= A[i * n + j] * b[j];
      b[i] = s / A[i * n + i];
    }
    return b;
  };
}

function basis(knots: number[], deg: number, i: number, t: number): number {
  const N: number[] = [];
  for (let j = 0; j <= deg; j++) {
    const a = knots[i + j];
    const b = knots[i + j + 1];
    N[j] = (t >= a && t < b) || (t === 1 && b === 1 && a < b) ? 1 : 0;
  }
  for (let k = 1; k <= deg; k++) {
    for (let j = 0; j <= deg - k; j++) {
      const a = knots[i + j];
      const b = knots[i + j + k];
      const c = knots[i + j + 1];
      const d = knots[i + j + k + 1];
      N[j] = (b > a ? ((t - a) / (b - a)) * N[j] : 0) + (d > c ? ((d - t) / (d - c)) * N[j + 1] : 0);
    }
  }
  return N[0];
}

export interface BSplineFit {
  NU: number;
  /** Number of V poles (NV + 2, clamped-cubic). */
  nvp: number;
  uKnots: number[];
  uMults: number[];
  vKnots: number[];
  vMults: number[];
  pole(i: number, k: number): Vec3;
}

/**
 * Fit a tensor-product cubic B-spline surface to an NU (periodic) x NV
 * (clamped) grid of points, given analytic end tangents dv0/dv1 at v=0/v=1.
 *
 * `point(i, j)` returns the data at u_i = i/NU (i in [0,NU)), v_j = j/(NV-1).
 */
export function fitPeriodicUClampedV(
  NU: number,
  NV: number,
  point: (i: number, j: number) => Vec3,
  dv0: (i: number) => Vec3,
  dv1: (i: number) => Vec3,
): BSplineFit {
  const nvp = NV + 2;
  const dv = 1 / (NV - 1);
  const vk = [0, 0, 0, 0];
  for (let j = 1; j < NV - 1; j++) vk.push(j * dv);
  vk.push(1, 1, 1, 1);
  const Mv = new Float64Array(nvp * nvp);
  // Row order: 0: Q0 = D0; 1: tangent start; 2..NV-1: interior data;
  // NV: tangent end; NV+1: D_end.
  Mv[0] = 1;
  Mv[1 * nvp + 0] = -1;
  Mv[1 * nvp + 1] = 1;
  for (let j = 1; j < NV - 1; j++) for (let k = 0; k < nvp; k++) Mv[(j + 1) * nvp + k] = basis(vk, 3, k, j * dv);
  Mv[NV * nvp + nvp - 2] = -1;
  Mv[NV * nvp + nvp - 1] = 1;
  Mv[(nvp - 1) * nvp + nvp - 1] = 1;
  const solveV = luFactor(Mv, nvp);

  // Q[i][k][c]
  const Q = new Float64Array(NU * nvp * 3);
  const b = new Float64Array(nvp);
  for (let i = 0; i < NU; i++) {
    const D: Vec3[] = [];
    for (let j = 0; j < NV; j++) D.push(point(i, j));
    const t0 = dv0(i);
    const t1 = dv1(i);
    for (let c = 0; c < 3; c++) {
      b[0] = D[0][c];
      b[1] = (t0[c] * dv) / 3;
      for (let j = 1; j < NV - 1; j++) b[j + 1] = D[j][c];
      b[NV] = (t1[c] * dv) / 3;
      b[nvp - 1] = D[NV - 1][c];
      solveV(b);
      for (let k = 0; k < nvp; k++) Q[(i * nvp + k) * 3 + c] = b[k];
    }
  }

  // U: periodic uniform cubic, value at knot i = (C[i-1] + 4 C[i] + C[i+1]) / 6.
  const Mu = new Float64Array(NU * NU);
  for (let i = 0; i < NU; i++) {
    Mu[i * NU + ((i - 1 + NU) % NU)] += 1 / 6;
    Mu[i * NU + i] += 4 / 6;
    Mu[i * NU + ((i + 1) % NU)] += 1 / 6;
  }
  const solveU = luFactor(Mu, NU);
  const P = new Float64Array(NU * nvp * 3);
  const bu = new Float64Array(NU);
  for (let k = 0; k < nvp; k++) {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < NU; i++) bu[i] = Q[(i * nvp + k) * 3 + c];
      solveU(bu);
      for (let i = 0; i < NU; i++) P[(i * nvp + k) * 3 + c] = bu[i];
    }
  }

  const uKnots: number[] = [];
  for (let i = 0; i <= NU; i++) uKnots.push(i / NU);
  const vKnots: number[] = [];
  for (let j = 0; j < NV; j++) vKnots.push(j * dv);
  vKnots[NV - 1] = 1;
  const vMults = vKnots.map((_, j) => (j === 0 || j === NV - 1 ? 4 : 1));

  return {
    NU,
    nvp,
    uKnots,
    uMults: uKnots.map(() => 1),
    vKnots,
    vMults,
    pole: (i, k) => [P[(i * nvp + k) * 3], P[(i * nvp + k) * 3 + 1], P[(i * nvp + k) * 3 + 2]],
  };
}
