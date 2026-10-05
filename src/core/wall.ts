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

import { GROOVE_DEPTH_FACTOR, GROOVE_FLOOR_WALL, GROOVE_LIP_ANGLE, GROOVE_SLACK, MARGIN_BOTTOM, MARGIN_TOP_FACTOR, RIDGE_LAND, WALL_THICKNESS } from "./constants";
import { chamferedRim } from "./edgeChamfer";
import { arcLengthFractionAt, outlineColumnParams, outlineOffsetAt, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh } from "./types";

/** The groove's cross-section for one cable (docs/design.md, Geometry: Groove). */
export interface GrooveShape {
  /** Depth below the outer (winding) surface, mm. Layer 1's centre is `wireDiameter / 2 - depth` outside the surface. */
  depth: number;
  /** Radius of the groove circle, mm. */
  radius: number;
  /** Helical pitch, mm: the groove's width at the surface plus RIDGE_LAND. */
  pitch: number;
}

/** How far the groove circle reaches below its centre before it meets the surface, and how far its 45 degree upper flank reaches above it. */
function grooveReach(radius: number, depth: number): { down: number; up: number } {
  const c = radius - depth;
  const lip = lipChamfer(radius, depth);
  const down = lip ? lip.dz - lip.x / lip.slope : c >= radius ? 0 : Math.sqrt(Math.max(0, radius * radius - c * c));
  return { down, up: radius * Math.SQRT2 - c };
}

/**
 * Where the groove circle's lower flank would leave the ridge steeper than
 * GROOVE_LIP_ANGLE from the axis, it runs on as a straight chamfer instead,
 * tangent to the circle `dz` below its centre and `x` (< 0) from the
 * surface, rising `slope` mm outward per mm down. A deep groove's circle
 * would otherwise meet the ridge almost flat, in a near knife-edge corner.
 */
function lipChamfer(radius: number, depth: number): { dz: number; x: number; slope: number } | undefined {
  const a = (GROOVE_LIP_ANGLE * Math.PI) / 180;
  const x = radius - depth - radius * Math.cos(a);
  return x < 0 ? { dz: radius * Math.sin(a), x, slope: Math.tan(a) } : undefined;
}

/** The groove for a cable of this diameter: shared by the solver, the wall and the inner-end lead-in. */
export function grooveShape(wireDiameter: number): GrooveShape {
  const depth = GROOVE_DEPTH_FACTOR * wireDiameter;
  const radius = wireDiameter / 2 + GROOVE_SLACK;
  const { down, up } = grooveReach(radius, depth);
  return { depth, radius, pitch: down + up + RIDGE_LAND };
}

/**
 * How far layer 1's centreline can climb on a core of this height (the
 * solver's usable winding height): from the groove start (`grooveStartHeight`
 * at MARGIN_BOTTOM) until the cable's top is MARGIN_TOP_FACTOR of its radius
 * below the wall's top face.
 */
export function windingSpan(height: number, wireDiameter: number): number {
  return height - grooveStartHeight(grooveShape(wireDiameter), MARGIN_BOTTOM) - (1 + MARGIN_TOP_FACTOR) * (wireDiameter / 2);
}

/** The core's wall thickness for a cable of this diameter: WALL_THICKNESS, or more where the groove needs it. */
export function wallThickness(wireDiameter: number): number {
  return Math.max(WALL_THICKNESS, grooveShape(wireDiameter).depth + GROOVE_FLOOR_WALL);
}

export interface WallSpec {
  /** The winding surface's outline at offset 0 (docs/design.md, Shapes). */
  outline: ShapeOutline;
  /** The bore's own outline at offset 0 (a true inward offset of `outline` by the wall thickness -- see design.ts). */
  boreOutline: ShapeOutline;
  height: number;
  wireDiameter: number;
  /** Helical pitch, mm (`grooveShape`). */
  pitch: number;
  /** Radius of the groove circle, mm. */
  grooveRadius: number;
  /** Depth of the groove below the outer (winding) surface, mm. */
  grooveDepth: number;
  /** Height of the groove's lower edge at layer 1's start above the wall's bottom (the flange face), mm. */
  marginBottom: number;
  marginTop: number;
  /** The groove fades out over this many turns at its top end. */
  taperTurns: number;
  /** The groove runs on this many turns before layer 1's start (level with it), fading out, so it is at full depth where layer 1 starts. */
  runInTurns: number;
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
  /** Helical pitch, mm (`grooveShape`). */
  pitch: number;
  /** Height of the groove centre (and layer 1's centreline) at layer 1's
   * start, phi = 0. The groove has its full depth from there on; before it
   * the run-in, level with it, fades out. */
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
  /** The mesh's rows in one pitch, as heights above a groove centre in
   * [0, pitch): `n` spaced evenly along the profile's own length (so the
   * steep edges of the groove get as many as the flat floor), plus one on
   * each corner (the floor, both flanks' tangent points and both ends of the
   * ridge's land), so those come out exact. */
  rowOffsets(n: number): number[];
  /** True where the groove's fade (its top end, or its run-in) changes the surface: the full-depth groove would differ. */
  fading(t: number, z: number): boolean;
}

/**
 * The height layer 1's helix starts at (`WallProfile.zStart`): the bottom
 * margin plus how far the groove circle reaches below its own centre line.
 * Split out so innerEnd.ts can aim the inner-end lead-in at the same point
 * without a whole `WallSpec` (issue #115).
 */
export function grooveStartHeight(groove: Pick<GrooveShape, "radius" | "depth">, marginBottom: number): number {
  return marginBottom + grooveReach(groove.radius, groove.depth).down;
}

export function createWallProfile(spec: WallSpec): WallProfile {
  const { outline, pitch, grooveRadius: rho, grooveDepth: g, marginBottom, taperTurns: tau, runInTurns: tauIn, turns } = spec;

  // Teardrop profile: a groove circle of radius rho, with its upper flank
  // replaced by a 45 degree tangent line so it prints upright with no
  // overhang (docs/design.md, Geometry: Groove).
  const c = rho - g;
  const s45 = Math.SQRT1_2;
  const dz45 = rho * s45;
  const f45 = c - rho * s45;
  const lip = lipChamfer(rho, g);
  const profile = (dz: number): number => {
    if (dz > dz45) return f45 + (dz - dz45);
    if (lip && dz < -lip.dz) return lip.x + (-lip.dz - dz) * lip.slope;
    return Math.abs(dz) >= rho ? 1e9 : c - Math.sqrt(rho * rho - dz * dz);
  };
  const zStart = grooveStartHeight({ radius: rho, depth: g }, marginBottom);
  // Full depth from layer 1's start (phi = 0) on: the run-in below it fades in
  // over `tauIn` turns, the top end fades out over `tau`.
  const taper = (phi: number) => smoothstep((phi + tauIn) / Math.max(tauIn, 1e-9)) * smoothstep((turns - phi) / tau);

  // Issue #103: the helix's own phase, re-derived from the GROOVE FLOOR's
  // own arc length (offset -g) instead of `t` itself (an arc-length fraction
  // of the un-grooved winding surface, offset 0) -- see
  // `shapes.ts`'s `arcLengthFractionAt` for why the two differ on a corner
  // arc and not on a flat side, and why that's what was bunching consecutive
  // groove rings together at every corner.
  const phaseFraction = (t: number): number => arcLengthFractionAt(outline, -g, t);

  // Surface offset (<=0, inward) at arc-length fraction t and height z: the
  // minimum over the (at most 2) nearby helix turns, tapered out at the ends.
  const offset = (t: number, z: number, fullDepth = false): number => {
    const phase = phaseFraction(t);
    const q = (z - zStart) / pitch - phase;
    const k0 = Math.floor(q);
    let f = 0;
    for (let k = k0; k <= k0 + 1; k++) {
      const phi = k + phase;
      if (phi <= -tauIn || phi >= turns) continue;
      // The run-in below layer 1's start stays level with it (it doesn't follow
      // the helix down into the flange face).
      const dz = z - zStart - pitch * Math.max(phi, 0);
      const v = profile(dz) + (fullDepth ? 0 : (1 - taper(phi)) * g);
      if (v < f) f = v;
    }
    return f;
  };

  const point = (t: number, z: number): [number, number, number] => {
    const off = offset(t, z);
    const p = pointAt(outline, t, off);
    return [p.x, p.y, z];
  };

  // The 45 degree flank meets the surface where the ridge's land starts; the
  // next groove's edge, where it ends.
  const landEnd = pitch - grooveReach(rho, g).down;
  // One row in the middle of the land, none on its two ends: the mesh's crest
  // is then one sharp edge (as a nozzle prints it), not two creases a fraction
  // of a millimetre apart that the viewer would draw as one broken line.
  const landStart = dz45 - f45;
  const corners = [0, dz45, (landStart + landEnd) / 2, ...(lip ? [pitch - lip.dz] : [])].filter((h) => h >= 0 && h < pitch);
  const rowOffsets = (n: number): number[] => {
    // The full-depth surface over one pitch, and its length so far at each sample.
    const M = 2000;
    const hs: number[] = [];
    const len: number[] = [];
    let prev: [number, number] | undefined;
    for (let i = 0; i <= M; i++) {
      const h = (pitch * i) / M;
      const x = Math.min(0, profile(h), profile(h - pitch));
      len.push(prev ? len[len.length - 1] + Math.hypot(h - prev[0], x - prev[1]) : 0);
      hs.push(h);
      prev = [h, x];
    }
    const total = len[M];
    const lengthAt = (h: number) => len[Math.min(M, Math.round((h / pitch) * M))];
    const heightAt = (l: number) => {
      let i = 1;
      while (i < M && len[i] < l) i++;
      return hs[i - 1] + ((hs[i] - hs[i - 1]) * (l - len[i - 1])) / Math.max(len[i] - len[i - 1], 1e-12);
    };
    const step = total / n;
    const near = (l: number) => corners.some((c) => {
      const gap = Math.abs(l - lengthAt(c));
      return Math.min(gap, total - gap) < step / 4;
    }) || (l > lengthAt(landStart) - step / 4 && l < lengthAt(landEnd) + step / 4);
    const even = Array.from({ length: n }, (_, k) => k * step).filter((l) => !near(l)).map(heightAt);
    return [...corners, ...even].sort((a, b) => a - b);
  };
  // A point fades with the groove whose band it lies in: from the land's middle
  // below that groove to the land's middle above it. A point on the land's
  // middle is in both bands, so the crest above a fading groove fades with it
  // (on the crest the groove's depth doesn't show: there the offset is 0 either
  // way), while a full groove's own rows don't. The band's top is the land's
  // middle under the next turn, which follows the helix: the level run-in sits
  // up to `tauIn` pitches above it, and a band measured from the run-in would
  // take in that turn's crest, which then went undrawn.
  const landMiddle = (landStart + landEnd) / 2;
  const fading = (t: number, z: number) => {
    const phase = phaseFraction(t);
    const k0 = Math.floor((z - zStart) / pitch - phase);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const phi = k + phase;
      if (phi <= -tauIn || phi >= turns || taper(phi) > 1 - 1e-4) continue;
      const dz = z - zStart - pitch * Math.max(phi, 0);
      if (dz >= landMiddle - pitch - 1e-3 && z - zStart - pitch * phi <= landMiddle + 1e-3) return true;
    }
    return false;
  };
  return { pitch, zStart, offset: (t, z) => offset(t, z), point, phaseFraction, rowOffsets, fading };
}

/**
 * The outer wall's triangles in the finished core `mesh` where the groove fades out (types.ts's
 * `CoilMesh.fadeTriangles`). Found by position, like edgeChamfer.ts's `rimTriangles`, since the booleans don't track
 * faces: a triangle counts when each of its corners lies on the grooved wall surface, in its fade.
 */
export function grooveFadeTriangles(mesh: CoilMesh, spec: WallSpec): Uint32Array | undefined {
  const profile = createWallProfile(spec);
  const { outline, height } = spec;
  // The outline parameter t of a point on the outline, from its polar angle (the outline is convex about the axis).
  const N = 4096;
  const angles: number[] = [];
  for (let i = 0; i <= N; i++) {
    const p = pointAt(outline, i / N, 0);
    let a = Math.atan2(p.y, p.x);
    while (i > 0 && a < angles[i - 1]) a += 2 * Math.PI;
    angles.push(a);
  }
  const tAt = (x: number, y: number): number => {
    let a = Math.atan2(y, x);
    while (a < angles[0]) a += 2 * Math.PI;
    while (a >= angles[0] + 2 * Math.PI) a -= 2 * Math.PI;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (angles[mid] <= a) lo = mid;
      else hi = mid;
    }
    return (lo + (a - angles[lo]) / Math.max(angles[lo + 1] - angles[lo], 1e-12)) / N;
  };
  const p = mesh.positions;
  const fadeLow = profile.zStart + profile.pitch;
  const fadeHigh = profile.zStart + profile.pitch * (spec.turns - spec.taperTurns - 1);
  const fades = new Map<number, boolean>();
  const fadeAt = (v: number): boolean => {
    let f = fades.get(v);
    if (f === undefined) {
      const x = p[v * 3];
      const y = p[v * 3 + 1];
      const z = p[v * 3 + 2];
      f = false;
      // Only near the run-in (layer 1's start) or the top end can the groove fade.
      if (z > 0 && z < height && (z < fadeLow || z > fadeHigh)) {
        // The point on the outline the vertex lies off, along its normal.
        const { offset, nx, ny } = outlineOffsetAt(outline, x, y);
        const t = tAt(x - offset * nx, y - offset * ny);
        f = Math.abs(offset - profile.offset(t, z)) < 0.02 && profile.fading(t, z);
      }
      fades.set(v, f);
    }
    return f;
  };
  const t = mesh.indices;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 3) if (fadeAt(t[i]) && fadeAt(t[i + 1]) && fadeAt(t[i + 2])) out.push(i / 3);
  return out.length > 0 ? new Uint32Array(out) : undefined;
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
  const rowOffsets = profile.rowOffsets(rowsPerPitch);
  // The lowest row stays a quarter row above z = 0, so it never lands on the bottom vertex.
  const zLo = Math.max(marginBottom * 0.5, delta * 0.25);
  const zHi = height - marginTop * 0.5;

  const positions: number[] = [];
  const indices: number[] = [];
  const colIdx: number[][] = [];
  const colZ: number[][] = [];
  const bottomO: number[] = [];
  const topO: number[] = [];

  // Sheared (helical) rows: each column's rows sit at z = zStart +
  // pitch*phaseFraction(t) + k*pitch + one of `rowOffsets`, so every column samples the groove
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
    const kMin = Math.floor((zLo - z0) / pitch);
    const kMax = Math.ceil((zHi - z0) / pitch);
    for (let k = kMin; k <= kMax; k++) {
      for (const h of rowOffsets) {
        const z = z0 + k * pitch + h;
        if (z >= zLo && z <= zHi) push(z);
      }
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
