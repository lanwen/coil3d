
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

function solveTridiagonal(sub: Float64Array, diag: Float64Array, sup: Float64Array, rhs: Float64Array, n: number): Float64Array {
  const supScaled = new Float64Array(n);
  const rhsScaled = new Float64Array(n);
  supScaled[0] = sup[0] / diag[0];
  rhsScaled[0] = rhs[0] / diag[0];
  for (let i = 1; i < n; i++) {
    const pivot = diag[i] - sub[i] * supScaled[i - 1];
    supScaled[i] = sup[i] / pivot;
    rhsScaled[i] = (rhs[i] - sub[i] * rhsScaled[i - 1]) / pivot;
  }
  const x = new Float64Array(n);
  x[n - 1] = rhsScaled[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = rhsScaled[i] - supScaled[i] * x[i + 1];
  return x;
}

function solveCyclicTridiagonal(
  sub: Float64Array,
  diag: Float64Array,
  sup: Float64Array,
  cornerTopRight: number,
  cornerBottomLeft: number,
  rhs: Float64Array,
  n: number,
): Float64Array {
  const gamma = -diag[0];
  const diagAdjusted = new Float64Array(diag);
  diagAdjusted[0] = diag[0] - gamma;
  diagAdjusted[n - 1] = diag[n - 1] - (cornerTopRight * cornerBottomLeft) / gamma;

  const x = solveTridiagonal(sub, diagAdjusted, sup, rhs, n);
  const correction = new Float64Array(n);
  correction[0] = gamma;
  correction[n - 1] = cornerBottomLeft;
  const z = solveTridiagonal(sub, diagAdjusted, sup, correction, n);

  const factor = (x[0] + (cornerTopRight * x[n - 1]) / gamma) / (1 + z[0] + (cornerTopRight * z[n - 1]) / gamma);
  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) result[i] = x[i] - factor * z[i];
  return result;
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
  nvp: number;
  uKnots: number[];
  uMults: number[];
  vKnots: number[];
  vMults: number[];
  pole(i: number, k: number): Vec3;
}

const CUBIC = 3;
const PERIODIC_KNOT_MARGIN = 4;

function clampedVSystem(NV: number): { solve: (rhs: Float64Array) => Float64Array; dv: number } {
  const nvp = NV + 2;
  const dv = 1 / (NV - 1);
  const knots = [0, 0, 0, 0];
  for (let j = 1; j < NV - 1; j++) knots.push(j * dv);
  knots.push(1, 1, 1, 1);
  const tangentStartRow = 1;
  const tangentEndRow = NV;
  const matrix = new Float64Array(nvp * nvp);
  matrix[0] = 1;
  matrix[tangentStartRow * nvp + 0] = -1;
  matrix[tangentStartRow * nvp + 1] = 1;
  for (let j = 1; j < NV - 1; j++) for (let k = 0; k < nvp; k++) matrix[(j + 1) * nvp + k] = basis(knots, CUBIC, k, j * dv);
  matrix[tangentEndRow * nvp + nvp - 2] = -1;
  matrix[tangentEndRow * nvp + nvp - 1] = 1;
  matrix[(nvp - 1) * nvp + nvp - 1] = 1;
  return { solve: luFactor(matrix, nvp), dv };
}

function periodicKnotsAround(uParams: number[]): number[] {
  const NU = uParams.length;
  const knots: number[] = [];
  for (let q = -PERIODIC_KNOT_MARGIN; q <= NU + PERIODIC_KNOT_MARGIN; q++) {
    const wrap = ((q % NU) + NU) % NU;
    const period = Math.floor(q / NU);
    knots.push(uParams[wrap] + period);
  }
  return knots;
}

export function fitPeriodicUClampedV(
  uParams: number[],
  NV: number,
  point: (i: number, j: number) => Vec3,
  dv0: (i: number) => Vec3,
  dv1: (i: number) => Vec3,
): BSplineFit {
  const NU = uParams.length;
  const nvp = NV + 2;
  const { solve: solveV, dv } = clampedVSystem(NV);

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

  const extendedKnots = periodicKnotsAround(uParams);
  const basisIndex = (logical: number) => logical + PERIODIC_KNOT_MARGIN;

  const uSub = new Float64Array(NU);
  const uDiag = new Float64Array(NU);
  const uSuper = new Float64Array(NU);
  for (let i = 0; i < NU; i++) {
    const t = uParams[i];
    uSub[i] = basis(extendedKnots, CUBIC, basisIndex(i - 3), t);
    uDiag[i] = basis(extendedKnots, CUBIC, basisIndex(i - 2), t);
    uSuper[i] = basis(extendedKnots, CUBIC, basisIndex(i - 1), t);
  }
  const cornerTopRight = uSub[0];
  const cornerBottomLeft = uSuper[NU - 1];

  const P = new Float64Array(NU * nvp * 3);
  const bu = new Float64Array(NU);
  for (let k = 0; k < nvp; k++) {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < NU; i++) bu[i] = Q[(i * nvp + k) * 3 + c];
      const xu = solveCyclicTridiagonal(uSub, uDiag, uSuper, cornerTopRight, cornerBottomLeft, bu, NU);
      for (let i = 0; i < NU; i++) P[(i * nvp + k) * 3 + c] = xu[i];
    }
  }

  const uKnots: number[] = [...uParams, uParams[0] + 1];
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
