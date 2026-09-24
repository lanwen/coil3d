// Direct parametric mesh for a round, grooved tube wall. No sweep, no
// boolean: every vertex is placed analytically. Adapted from the S1 spike
// (spikes/s1-grooved-wall/geom.ts), specialised to a round cross-section
// only (docs/research.md §4, §10a).
//
// The wall is already a closed, watertight torus-like solid on its own: the
// outer wall, the bore, and the flat annuli at z=0 and z=height are all
// connected. Fusing the bottom flange (see manifold.ts) only extends it.

import type { CoilMesh } from "./types";

export interface WallSpec {
  outerRadius: number;
  boreRadius: number;
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

export function buildRoundWall(spec: WallSpec): CoilMesh {
  const {
    outerRadius,
    boreRadius,
    height,
    wireDiameter: d,
    clearance,
    grooveDepth: g,
    marginBottom,
    marginTop,
    taperTurns: tau,
    turns,
    columns: C,
    rowsPerPitch,
  } = spec;

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
  const groove = (t: number, z: number): number => {
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
    const theta = 2 * Math.PI * t;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const idx: number[] = [];
    const zz: number[] = [];
    const push = (z: number, off: number) => {
      idx.push(positions.length / 3);
      zz.push(z);
      positions.push(nx * (outerRadius + off), ny * (outerRadius + off), z);
    };
    push(0, 0);
    bottomO.push(idx[0]);
    const z0 = zStart + pitch * t;
    const jMin = Math.ceil((zLo - z0) / delta);
    const jMax = Math.floor((zHi - z0) / delta);
    for (let j = jMin; j <= jMax; j++) {
      const z = z0 + j * delta;
      push(z, groove(t, z));
    }
    push(height, 0);
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

  // Bore (plain cylinder, 2 vertices per column) and the top/bottom annuli
  // that close the wall into a watertight torus.
  const bottomI: number[] = [];
  const topI: number[] = [];
  for (let ci = 0; ci < C; ci++) {
    const theta = 2 * Math.PI * (ci / C);
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    bottomI.push(positions.length / 3);
    positions.push(nx * boreRadius, ny * boreRadius, 0);
    topI.push(positions.length / 3);
    positions.push(nx * boreRadius, ny * boreRadius, height);
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
