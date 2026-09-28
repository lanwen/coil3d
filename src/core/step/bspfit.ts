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

/**
 * Thomas algorithm: solves a plain (non-cyclic) tridiagonal system in O(n),
 * sub-diagonal `a` (a[0] unused), diagonal `b`, super-diagonal `c` (c[n-1]
 * unused). Read-only in `a`/`b`/`c`/`d`. Shared by `solveCyclicTridiagonal`
 * below (issue #85 PR review round 2), which calls this twice per
 * right-hand side (same `a`/`b`/`c`, two different `d`s).
 */
function solveTridiagonal(a: Float64Array, b: Float64Array, c: Float64Array, d: Float64Array, n: number): Float64Array {
  const cp = new Float64Array(n);
  const dp = new Float64Array(n);
  cp[0] = c[0] / b[0];
  dp[0] = d[0] / b[0];
  for (let i = 1; i < n; i++) {
    const m = b[i] - a[i] * cp[i - 1];
    cp[i] = c[i] / m;
    dp[i] = (d[i] - a[i] * dp[i - 1]) / m;
  }
  const x = new Float64Array(n);
  x[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
  return x;
}

/**
 * Solves a CYCLIC tridiagonal system (row `i` also references `x[(i-1+n)%n]`
 * and `x[(i+1)%n]`, i.e. periodic wraparound at both ends) in O(n), via the
 * standard Sherman-Morrison reduction to two plain tridiagonal solves (see
 * e.g. Numerical Recipes' `cyclic`): write the cyclic matrix as `T + u vT`
 * (a plain tridiagonal `T` plus a rank-1 correction capturing the two
 * corner entries `alpha` (row 0's own wraparound entry, at column `n-1`)
 * and `beta` (row `n-1`'s own wraparound entry, at column 0)), solve `T`
 * against both the real right-hand side and the correction vector, then
 * combine.
 *
 * Issue #85 PR review round 2: this replaces a DENSE O(n^3) `luFactor` call
 * for `fitPeriodicUClampedV`'s own periodic cubic U system (`Mu`-equivalent
 * below, always exactly tridiagonal-plus-corners regardless of whether the
 * knot spacing is uniform -- see that function's own comment). `a`/`b`/`c`
 * are the row-`i` coefficients multiplying `x[i-1]`/`x[i]`/`x[i+1]` for the
 * NON-wraparound entries (a[0] and c[n-1] are unused, mirroring
 * `solveTridiagonal`); requires `n >= 3` (a cyclic system of 1-2 unknowns
 * degenerates -- unreachable here, `NU` is always a mesh column count, at
 * least in the tens).
 */
function solveCyclicTridiagonal(a: Float64Array, b: Float64Array, c: Float64Array, alpha: number, beta: number, d: Float64Array, n: number): Float64Array {
  const gamma = -b[0];
  const bMod = new Float64Array(b);
  bMod[0] = b[0] - gamma;
  bMod[n - 1] = b[n - 1] - (alpha * beta) / gamma;

  // Rank-1 correction `u vT` recovering the two corner entries: with
  // `u = (gamma, 0, ..., 0, beta)` and `v = (1, 0, ..., 0, alpha / gamma)`,
  // `(u vT)[0][n-1] = gamma * (alpha/gamma) = alpha` and
  // `(u vT)[n-1][0] = beta * 1 = beta`, matching `A`'s own corner entries
  // (row 0's own entry at column n-1 is `alpha`; row n-1's own entry at
  // column 0 is `beta`) -- NOT `u[n-1] = alpha` paired with a `beta`-based
  // `v` (an easy transcription slip from Numerical Recipes' own `cyclic`,
  // whose `alpha`/`beta` naming this project's own `a[0]`/`c[n-1]`-derived
  // ones don't map onto 1:1 -- caught only once alpha != beta, i.e. once
  // the coefficients stopped being the old CONSTANT 1/6, 4/6, 1/6 special
  // case, issue #85 PR review round 2).
  const x = solveTridiagonal(a, bMod, c, d, n);
  const u = new Float64Array(n);
  u[0] = gamma;
  u[n - 1] = beta;
  const z = solveTridiagonal(a, bMod, c, u, n);

  const fact = (x[0] + (alpha * x[n - 1]) / gamma) / (1 + z[0] + (alpha * z[n - 1]) / gamma);
  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) result[i] = x[i] - fact * z[i];
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
 * `point(i, j)` returns the data at u_i = `uParams[i]`, v_j = j/(NV-1).
 * `uParams` need not be uniformly spaced (issue #85 PR review round 2: the
 * mesh backend's own corner-favoring sample placement, shapes.ts's
 * `outlineColumnParams`, is reused here too, so the STEP wall's corner arcs
 * get the SAME segment density as the mesh -- without this, only raising
 * NU uniformly could reach the same per-corner density, but for a shape
 * whose corner is a small share of the perimeter that meant a much bigger
 * NU than the mesh ever needs, and OCCT's own boolean ops against the
 * resulting surface scale with NU badly enough that it blew well past a 2x
 * build-time budget -- see this function's own git history/PR discussion).
 * Only `uParams[0]` is assumed to be exactly 0 (matches
 * `outlineColumnParams`'s own convention) -- the values must otherwise be
 * strictly increasing across [0, 1).
 */
export function fitPeriodicUClampedV(
  uParams: number[],
  NV: number,
  point: (i: number, j: number) => Vec3,
  dv0: (i: number) => Vec3,
  dv1: (i: number) => Vec3,
): BSplineFit {
  const NU = uParams.length;
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

  // U: periodic cubic, generally NON-uniform (issue #85 PR review round 2):
  // row i's own collocation equation (the spline's value AT its own knot
  // `uParams[i]`) is `a[i]*P[i-1] + b[i]*P[i] + c[i]*P[i+1] = D_i`, where
  // a[i]/b[i]/c[i] are cubic B-spline basis function values -- a UNIFORM
  // knot spacing reduces this to the textbook constant 1/6, 4/6, 1/6 this
  // file used before (only 3 basis functions are ever nonzero at a simple
  // knot, regardless of spacing -- the same local-support property that
  // makes the UNIFORM case tridiagonal at all), but the general,
  // non-constant values are needed once corner arcs get denser samples
  // than the straight sides flanking them (the mesh backend's own
  // `outlineColumnParams`) -- computed via the same Cox-de-Boor recursion
  // (`basis`) the V-direction system above already uses, over a knot
  // vector built by extending `uParams` periodically (period 1) far enough
  // each way for a degree-3 basis function's own local support.
  const MARGIN = 4;
  const extKnots: number[] = [];
  for (let q = -MARGIN; q <= NU + MARGIN; q++) {
    const wrap = ((q % NU) + NU) % NU;
    const period = Math.floor(q / NU);
    extKnots.push(uParams[wrap] + period);
  }
  const arrIdx = (logical: number) => logical + MARGIN;

  const uSub = new Float64Array(NU);
  const uDiag = new Float64Array(NU);
  const uSuper = new Float64Array(NU);
  // A degree-3 basis function `N_{j,3}` is supported on knot span
  // `[knots[j], knots[j+4])`, "centered" (its own peak, for a uniform
  // spacing) at `knots[j+2]` -- so the basis function centered AT knot `i`
  // is `N_{i-2,3}`, and the three nonzero at `t = uParams[i]` are
  // `N_{i-3,3}` (pole i-1), `N_{i-2,3}` (pole i), `N_{i-1,3}` (pole i+1).
  // Empirically verified against the known uniform answer (1/6, 4/6, 1/6)
  // before trusting this for the general non-uniform case.
  for (let i = 0; i < NU; i++) {
    const t = uParams[i];
    uSub[i] = basis(extKnots, 3, arrIdx(i - 3), t);
    uDiag[i] = basis(extKnots, 3, arrIdx(i - 2), t);
    uSuper[i] = basis(extKnots, 3, arrIdx(i - 1), t);
  }
  // Row 0's own wraparound coefficient (on P_{-1} = P_{NU-1}) is `uSub[0]`
  // itself (already correctly computed above against the EXTENDED knot
  // vector); same for row NU-1's wraparound coefficient (on P_{NU} = P_0),
  // `uSuper[NU-1]`. `solveCyclicTridiagonal` doesn't read `uSub[0]`/
  // `uSuper[NU-1]` as part of its own plain-tridiagonal reduction (see its
  // own doc comment), so passing the SAME values there too is harmless.
  const alpha = uSub[0];
  const beta = uSuper[NU - 1];

  const P = new Float64Array(NU * nvp * 3);
  const bu = new Float64Array(NU);
  for (let k = 0; k < nvp; k++) {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < NU; i++) bu[i] = Q[(i * nvp + k) * 3 + c];
      const xu = solveCyclicTridiagonal(uSub, uDiag, uSuper, alpha, beta, bu, NU);
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
