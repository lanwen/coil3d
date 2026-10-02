// Direct parametric mesh for a grooved tube wall, and the flange ring that
// gets fused onto it. No sweep, no boolean: every vertex is placed
// analytically. Adapted from an early prototype,
// generalised from round-only to any convex ShapeOutline (issue #6): round,
// rounded square and rounded triangle share this one implementation (round
// is the degenerate n=4, cornerRadius=apothem outline, see shapes.ts).
//
// The wall is already a closed, watertight torus-like solid on its own: the
// outer wall, the bore, and the flat annuli at z=0 and z=height are all
// connected. Fusing the bottom flange (see manifold.ts) only extends it.

import { chamferedRim } from "./edgeChamfer";
import { arcLengthFractionAt, outlineColumnParams, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh } from "./types";

export interface WallSpec {
  /** The winding surface's outline at offset 0 (docs/design.md, Shapes). */
  outline: ShapeOutline;
  /** The bore's own outline at offset 0 (a true inward offset of `outline` by the wall thickness -- see design.ts). */
  boreOutline: ShapeOutline;
  height: number;
  wireDiameter: number;
  clearance: number;
  /** Depth of the groove below the outer (winding) surface, mm. */
  grooveDepth: number;
  marginBottom: number;
  marginTop: number;
  /** The groove fades out over this many turns at each end. */
  taperTurns: number;
  turns: number;
  /** Columns around the circumference (a requested BUDGET -- see `minCornerSegments`; STEP's own B-spline fit (step/build.ts) reuses this exact number as its own uniform sample count, so it never changes here). */
  columns: number;
  /** Mesh rows per helical pitch (controls groove fidelity). */
  rowsPerPitch: number;
  /** Issue #85: minimum corner-arc segments (shapes.ts's `minCornerSegments`, already scaled to this outline's own corner sweep) -- `buildWall`/`buildOutlineRing` redistribute `columns` toward corners to reach it, via `outlineColumnParams`. Round ignores this (no corner arc of its own). */
  minCornerSegments: number;
}

export const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** The analytic grooved-wall grid, shared by the mesh backend (this file)
 * and the STEP backend (step/build.ts): both must sample the exact same
 * `point(t, z)` so the two exports never drift apart (docs/design.md,
 * Export). */
export interface WallProfile {
  /** Helical pitch, mm (wireDiameter + clearance). */
  pitch: number;
  /** Axial height at which the grooved region notionally starts (used only
   * to place mesh sampling rows; the groove itself fades to 0 before this
   * via `taper`, so `point` is flat well before and after it). */
  zStart: number;
  /** Signed inward radial offset (<=0) of the outer wall at arc-length
   * fraction t in [0,1) and axial height z in [0,height]. */
  offset(t: number, z: number): number;
  /** Cartesian point on the outer (grooved) wall surface for the same
   * (t, z). Flat (offset 0) at z=0 and z=height by construction. */
  point(t: number, z: number): [number, number, number];
  /** The helix's own phase at arc-length fraction t: the true arc-length
   * fraction of the GROOVE FLOOR's own outline (offset -grooveDepth), not
   * the winding surface's (issue #103, see `shapes.ts`'s
   * `arcLengthFractionAt`) -- what `z = zStart + pitch*phase(t)` and the
   * nearby-turn search in `offset` above should advance by, so the helix
   * pitch reads constant along the surface the wire actually sits in
   * instead of bunching at every corner. `buildWall` reuses this same
   * function for its own per-column row phase (`z0`), so the mesh's row
   * shear and the profile it samples can never disagree about where a
   * groove ring actually falls. */
  phaseFraction(t: number): number;
}

/**
 * The height layer 1's helix starts at (`WallProfile.zStart`): the bottom
 * margin plus how far the groove circle reaches below its own centre line.
 * Split out so innerEnd.ts can aim the inner-end lead-in at the same point
 * without a whole `WallSpec` (issue #115).
 */
export function grooveStartHeight(wireDiameter: number, clearance: number, grooveDepth: number, marginBottom: number): number {
  const rho = wireDiameter / 2 + clearance / 2;
  const c = rho - grooveDepth;
  const halfDown = c >= rho ? 0 : Math.sqrt(Math.max(0, rho * rho - c * c));
  return marginBottom + halfDown;
}

export function createWallProfile(spec: WallSpec): WallProfile {
  const { outline, wireDiameter: d, clearance, grooveDepth: g, marginBottom, taperTurns: tau, turns } = spec;

  const pitch = d + clearance;
  // Teardrop profile: a groove circle of radius rho, with its upper flank
  // replaced by a 45 degree tangent line so it prints upright with no
  // overhang (docs/design.md, Geometry: Groove).
  const rho = d / 2 + clearance / 2;
  const c = rho - g;
  const s45 = Math.SQRT1_2;
  const dz45 = rho * s45;
  const f45 = c - rho * s45;
  const profile = (dz: number): number => {
    if (dz > dz45) return f45 + (dz - dz45);
    return Math.abs(dz) >= rho ? 1e9 : c - Math.sqrt(rho * rho - dz * dz);
  };
  const zStart = grooveStartHeight(d, clearance, g, marginBottom);
  const taper = (phi: number) => smoothstep(phi / tau) * smoothstep((turns - phi) / tau);

  // Issue #103: the helix's own phase, re-derived from the GROOVE FLOOR's
  // own arc length (offset -g) instead of `t` itself (an arc-length fraction
  // of the un-grooved winding surface, offset 0) -- see
  // `shapes.ts`'s `arcLengthFractionAt` for why the two differ on a corner
  // arc and not on a flat side, and why that's what was bunching consecutive
  // groove rings together at every corner.
  const phaseFraction = (t: number): number => arcLengthFractionAt(outline, -g, t);

  // Surface offset (<=0, inward) at arc-length fraction t and height z: the
  // minimum over the (at most 2) nearby helix turns, tapered out at the ends.
  const offset = (t: number, z: number): number => {
    const phase = phaseFraction(t);
    const q = (z - zStart) / pitch - phase;
    const k0 = Math.floor(q);
    let f = 0;
    for (let k = k0; k <= k0 + 1; k++) {
      const phi = k + phase;
      if (phi <= 0 || phi >= turns) continue;
      const dz = z - zStart - pitch * phi;
      const v = profile(dz) + (1 - taper(phi)) * (g + clearance);
      if (v < f) f = v;
    }
    return f;
  };

  const point = (t: number, z: number): [number, number, number] => {
    const off = offset(t, z);
    const p = pointAt(outline, t, off);
    return [p.x, p.y, z];
  };

  return { pitch, zStart, offset, point, phaseFraction };
}

export function buildWall(spec: WallSpec): CoilMesh {
  const { outline, boreOutline, height, marginBottom, marginTop, columns, minCornerSegments, rowsPerPitch } = spec;
  const profile = createWallProfile(spec);
  const { pitch, zStart } = profile;

  // Issue #85: adaptive, corner-favoring column placement, not a plain
  // `ci / columns` -- see `outlineColumnParams`'s own doc comment. `ts`'s
  // length is the mesh's REAL column count, which may exceed the
  // `columns` budget when the corner floor forces it to.
  const ts = outlineColumnParams(outline, columns, minCornerSegments);
  const C = ts.length;

  const delta = pitch / rowsPerPitch;
  const zLo = marginBottom * 0.5;
  const zHi = height - marginTop * 0.5;

  const positions: number[] = [];
  const indices: number[] = [];
  const colIdx: number[][] = [];
  const colZ: number[][] = [];
  const bottomO: number[] = [];
  const topO: number[] = [];

  // Sheared (helical) rows: each column's rows sit at z = zStart +
  // pitch*phaseFraction(t) + j*delta, so every column samples the groove
  // profile at the same phase `profile.offset` itself uses (issue #103: the
  // groove floor's own phase, not `t` directly -- see
  // `shapes.ts`'s `arcLengthFractionAt`). This is what makes the profile
  // exact with no aliasing, and what lets the t=0/t=1 seam close for free
  // (docs/design.md, Geometry). Non-uniform column spacing (issue #85) doesn't disturb
  // this: each column still samples its own exact arc-length fraction `t`,
  // just not evenly spaced from its neighbours.
  for (let ci = 0; ci < C; ci++) {
    const t = ts[ci];
    const idx: number[] = [];
    const zz: number[] = [];
    const push = (z: number) => {
      idx.push(positions.length / 3);
      zz.push(z);
      positions.push(...profile.point(t, z));
    };
    push(0);
    bottomO.push(idx[0]);
    const z0 = zStart + pitch * profile.phaseFraction(t);
    const jMin = Math.ceil((zLo - z0) / delta);
    const jMax = Math.floor((zHi - z0) / delta);
    for (let j = jMin; j <= jMax; j++) {
      push(z0 + j * delta);
    }
    push(height);
    topO.push(idx[idx.length - 1]);
    colIdx.push(idx);
    colZ.push(zz);
  }

  // Zipper adjacent columns together (z-sorted greedy merge).
  for (let ci = 0; ci < C; ci++) {
    const A = colIdx[ci];
    const Az = colZ[ci];
    const B = colIdx[(ci + 1) % C];
    const Bz = colZ[(ci + 1) % C];
    let i = 0;
    let j = 0;
    while (i < A.length - 1 || j < B.length - 1) {
      if (j === B.length - 1 || (i < A.length - 1 && Az[i + 1] <= Bz[j + 1])) {
        indices.push(A[i], B[j], A[i + 1]);
        i++;
      } else {
        indices.push(A[i], B[j], B[j + 1]);
        j++;
      }
    }
  }

  // Bore (its own outline, offset 0, 2 vertices per column) and the
  // top/bottom annuli that close the wall into a watertight torus.
  const bottomI: number[] = [];
  const topI: number[] = [];
  for (let ci = 0; ci < C; ci++) {
    const t = ts[ci];
    const p = pointAt(boreOutline, t, 0);
    bottomI.push(positions.length / 3);
    positions.push(p.x, p.y, 0);
    topI.push(positions.length / 3);
    positions.push(p.x, p.y, height);
  }
  for (let ci = 0; ci < C; ci++) {
    const cj = (ci + 1) % C;
    // Bore faces inward.
    indices.push(bottomI[ci], topI[ci], bottomI[cj]);
    indices.push(bottomI[cj], topI[ci], topI[cj]);
    // Bottom annulus faces -z.
    indices.push(bottomO[ci], bottomI[ci], bottomO[cj]);
    indices.push(bottomO[cj], bottomI[ci], bottomI[cj]);
    // Top annulus faces +z.
    indices.push(topO[ci], topO[cj], topI[ci]);
    indices.push(topO[cj], topI[cj], topI[ci]);
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * A flat, watertight prism ("washer") between two outlines: `outerOutline`
 * at `outerOffset` (typically the wall's own outline, offset outward by the
 * flange margin) and `innerOutline` at offset 0 (typically the same bore
 * outline as the wall). Used by manifold.ts to build the bottom flange
 * shaped like the core's own outline, not a bounding circle (issue #6 AC
 * "the flange for non-round shapes should follow the offset outline").
 *
 * Issue #85: `columns` is a requested BUDGET, redistributed toward
 * `outerOutline`'s own corner arcs (`outlineColumnParams`) so they don't
 * facet -- the ring's real column count (`ts.length`) may exceed it. The
 * SAME `t` values sample `innerOutline` too (matching the original plain
 * `ci / columns` scheme's own "same fractional position on both outlines"
 * approximation -- unchanged here, just no longer evenly spaced).
 */
export function buildOutlineRing(outerOutline: ShapeOutline, outerOffset: number, innerOutline: ShapeOutline, zLo: number, zHi: number, columns: number, minCornerSegments: number): CoilMesh {
  const positions: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    return idx;
  };

  const ts = outlineColumnParams(outerOutline, columns, minCornerSegments);

  // Issue #229: the outer edge is chamfered on both faces -- four rows of vertices up the rim (edgeChamfer.ts)
  // instead of two. The bottom and top annuli start at the first and last row.
  const rim = chamferedRim(outerOffset, zLo, zHi);
  const outer: number[][] = rim.map(() => []);
  const innerBottom: number[] = [];
  const innerTop: number[] = [];
  for (const t of ts) {
    // pointAt, like the inner outline: a round outline's own corner parameter starts 45 degrees round from its
    // `t`, which paired each outer column with an inner one 45 degrees away, and on a narrow annulus the twisted
    // strips folded back over each other (issue #219).
    rim.forEach((row, r) => {
      const o = pointAt(outerOutline, t, row.offset);
      outer[r].push(push(o.x, o.y, row.z));
    });
    const inner = pointAt(innerOutline, t, 0);
    innerBottom.push(push(inner.x, inner.y, zLo));
    innerTop.push(push(inner.x, inner.y, zHi));
  }

  const columnCount = ts.length;
  const outerBottom = outer[0];
  const outerTop = outer[rim.length - 1];
  const indices: number[] = [];
  for (let ci = 0; ci < columnCount; ci++) {
    const cj = (ci + 1) % columnCount;
    // Outer side wall faces outward: the lower chamfer, the land, the upper chamfer.
    for (let r = 0; r + 1 < rim.length; r++) {
      indices.push(outer[r][ci], outer[r][cj], outer[r + 1][ci]);
      indices.push(outer[r + 1][ci], outer[r][cj], outer[r + 1][cj]);
    }
    // Inner side wall (bore) faces inward.
    indices.push(innerBottom[ci], innerTop[ci], innerBottom[cj]);
    indices.push(innerBottom[cj], innerTop[ci], innerTop[cj]);
    // Bottom annulus faces -z.
    indices.push(outerBottom[ci], innerBottom[ci], outerBottom[cj]);
    indices.push(outerBottom[cj], innerBottom[ci], innerBottom[cj]);
    // Top annulus faces +z.
    indices.push(outerTop[ci], outerTop[cj], innerTop[ci]);
    indices.push(outerTop[cj], innerTop[cj], innerTop[ci]);
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
