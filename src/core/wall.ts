// Direct parametric mesh for a grooved tube wall, and the flange ring that
// gets fused onto it. No sweep, no boolean: every vertex is placed
// analytically. Adapted from the S1 spike (spikes/s1-grooved-wall/geom.ts),
// generalised from round-only to any convex ShapeOutline (issue #6): round,
// rounded square and rounded triangle share this one implementation (round
// is the degenerate n=4, cornerRadius=apothem outline, see shapes.ts).
//
// The wall is already a closed, watertight torus-like solid on its own: the
// outer wall, the bore, and the flat annuli at z=0 and z=height are all
// connected. Fusing the bottom flange (see manifold.ts) only extends it.

import { evalOutline, paramAt, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh } from "./types";

export interface WallSpec {
  /** The winding surface's outline at offset 0 (docs/research.md §2). */
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
  /** Columns around the circumference. */
  columns: number;
  /** Mesh rows per helical pitch (controls groove fidelity). */
  rowsPerPitch: number;
}

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** The analytic grooved-wall grid, shared by the mesh backend (this file)
 * and the STEP backend (step/build.ts): both must sample the exact same
 * `point(t, z)` so the two exports never drift apart (docs/research.md
 * "STEP", S2 RESULT.md). */
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
}

export function createWallProfile(spec: WallSpec): WallProfile {
  const { outline, wireDiameter: d, clearance, grooveDepth: g, marginBottom, taperTurns: tau, turns } = spec;

  const pitch = d + clearance;
  // Teardrop profile: a groove circle of radius rho, with its upper flank
  // replaced by a 45 degree tangent line so it prints upright with no
  // overhang (docs/research.md §4 "Groove design (FDM)").
  const rho = d / 2 + clearance / 2;
  const c = rho - g;
  const s45 = Math.SQRT1_2;
  const dz45 = rho * s45;
  const f45 = c - rho * s45;
  const profile = (dz: number): number => {
    if (dz > dz45) return f45 + (dz - dz45);
    return Math.abs(dz) >= rho ? 1e9 : c - Math.sqrt(rho * rho - dz * dz);
  };
  const halfDown = c >= rho ? 0 : Math.sqrt(Math.max(0, rho * rho - c * c));
  const zStart = marginBottom + halfDown;
  const taper = (phi: number) => smoothstep(phi / tau) * smoothstep((turns - phi) / tau);

  // Surface offset (<=0, inward) at arc-length fraction t and height z: the
  // minimum over the (at most 2) nearby helix turns, tapered out at the ends.
  const offset = (t: number, z: number): number => {
    const q = (z - zStart) / pitch - t;
    const k0 = Math.floor(q);
    let f = 0;
    for (let k = k0; k <= k0 + 1; k++) {
      const phi = k + t;
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

  return { pitch, zStart, offset, point };
}

export function buildWall(spec: WallSpec): CoilMesh {
  const { boreOutline, height, marginBottom, marginTop, columns: C, rowsPerPitch } = spec;
  const profile = createWallProfile(spec);
  const { pitch, zStart } = profile;

  const delta = pitch / rowsPerPitch;
  const zLo = marginBottom * 0.5;
  const zHi = height - marginTop * 0.5;

  const positions: number[] = [];
  const indices: number[] = [];
  const colIdx: number[][] = [];
  const colZ: number[][] = [];
  const bottomO: number[] = [];
  const topO: number[] = [];

  // Sheared (helical) rows: each column's rows sit at z = zStart + pitch*t +
  // j*delta, so every column samples the groove profile at the same phase.
  // This is what makes the profile exact with no aliasing, and what lets the
  // t=0/t=1 seam close for free (S1 RESULT.md).
  for (let ci = 0; ci < C; ci++) {
    const t = ci / C;
    const idx: number[] = [];
    const zz: number[] = [];
    const push = (z: number) => {
      idx.push(positions.length / 3);
      zz.push(z);
      positions.push(...profile.point(t, z));
    };
    push(0);
    bottomO.push(idx[0]);
    const z0 = zStart + pitch * t;
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
    const t = ci / C;
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
 */
export function buildOutlineRing(outerOutline: ShapeOutline, outerOffset: number, innerOutline: ShapeOutline, zLo: number, zHi: number, columns: number): CoilMesh {
  const positions: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    return idx;
  };

  const outerBottom: number[] = [];
  const outerTop: number[] = [];
  const innerBottom: number[] = [];
  const innerTop: number[] = [];
  for (let ci = 0; ci < columns; ci++) {
    const t = ci / columns;
    const o = evalOutline(outerOutline, paramAt(outerOutline, 0, t), outerOffset);
    const inner = pointAt(innerOutline, t, 0);
    outerBottom.push(push(o.x, o.y, zLo));
    outerTop.push(push(o.x, o.y, zHi));
    innerBottom.push(push(inner.x, inner.y, zLo));
    innerTop.push(push(inner.x, inner.y, zHi));
  }

  const indices: number[] = [];
  for (let ci = 0; ci < columns; ci++) {
    const cj = (ci + 1) % columns;
    // Outer side wall faces outward.
    indices.push(outerBottom[ci], outerBottom[cj], outerTop[ci]);
    indices.push(outerTop[ci], outerBottom[cj], outerTop[cj]);
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
