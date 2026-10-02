// Issue #229: the 45 degree chamfer on the outer perimeter edges of the
// bottom flange and the top cap, on both faces. One shared definition, so the
// mesh backend (manifold.ts, wall.ts) and the STEP backend (step/build.ts)
// can't drift: each rim is described as rows of (offset from the core's
// outline, z), and a backend turns the rows into its own surfaces.

import { EDGE_CHAMFER } from "./constants";
import { outlineOffsetAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh } from "./types";

/** One row of a rim profile: the outline offset outward by `offset` (mm), at height `z`. */
export interface RimRow {
  offset: number;
  z: number;
}

/**
 * The rim of a plate z = [zLo, zHi] whose outer edge is the core's outline
 * offset by `margin`: the chamfer's foot on each face, then the vertical land
 * between them (at least 1 mm on the thinnest plate, 3 mm). `lowSquare` leaves
 * the edge on the `zLo` face square: the top cap's underside, where the cable
 * clips' roots stand within a millimetre of the rim (constants.ts's CAP_CLIP_RIM_INSET)
 * and the chamfer would cut across them.
 */
export function chamferedRim(margin: number, zLo: number, zHi: number, lowSquare = false): RimRow[] {
  const c = EDGE_CHAMFER;
  return [
    ...(lowSquare ? [{ offset: margin, z: zLo }] : [{ offset: margin - c, z: zLo }, { offset: margin, z: zLo + c }]),
    { offset: margin, z: zHi - c },
    { offset: margin - c, z: zHi },
  ];
}

/**
 * The solid that keeps the rim chamfered at `zFace`, the flange's plate top where it is thinner than the pads
 * (flangePads.ts): a frustum from `zBelow` up to `zFace`, its 45 degree side running down and out from the chamfer's
 * foot on the face (`margin - EDGE_CHAMFER` at `zFace`). The mesh backend intersects the flange with it (and the
 * pads); the STEP backend subtracts it from the slab above the face, with `zBelow` just under the chamfer.
 */
export function chamferWedgeRows(margin: number, zFace: number, zBelow: number = zFace - EDGE_CHAMFER - 1): [RimRow, RimRow] {
  const c = EDGE_CHAMFER;
  return [
    { offset: margin - c + (zFace - zBelow), z: zBelow },
    { offset: margin - c, z: zFace },
  ];
}

/**
 * How far below the plate top the relief slab starts (flangePads.ts): below the chamfer's foot and the pads'
 * lowest level (`FLANGE_PAD_EMBED`, the same depth), so the slab's bottom face lies on neither. Below the foot the frustum covers the
 * whole rim, so how far down the slab starts changes nothing.
 */
export const SLAB_BELOW_FACE = EDGE_CHAMFER + 0.25;

/** How far a vertex may lie from the rim's ideal surface, mm: the sag of a corner arc's facets between two columns. */
const RIM_TOLERANCE = 0.15;
/** Heights are exact: the rim's rows are planes. */
const RIM_Z_TOLERANCE = 0.02;

/**
 * The rim triangles of a finished mesh (types.ts's `CoilMesh.rimTriangles`): those lying on the chamfer bands and on
 * the land between them, of every plate z = [zLo, zHi] in `bands` (a third entry true: square at `zLo`, as `chamferedRim`'s
 * `lowSquare`) whose outer edge is `outline` offset by `margin`
 * (a flange thinned to its plate has two: the plate and the pads). Found by position, since the booleans and the
 * clean-up passes that follow them don't track faces. Undefined when the mesh has no rim.
 */
export function rimTriangles(mesh: CoilMesh, outline: ShapeOutline, margin: number, bands: Array<[number, number, boolean?]>): CoilMesh["rimTriangles"] {
  const c = EDGE_CHAMFER;
  const p = mesh.positions;
  const t = mesh.indices;
  const chamfer: number[] = [];
  const land: number[] = [];
  const offsets = new Map<number, number>();
  const offsetOf = (v: number): number => {
    let d = offsets.get(v);
    if (d === undefined) offsets.set(v, (d = outlineOffsetAt(outline, p[v * 3], p[v * 3 + 1]).offset));
    return d;
  };
  const zMin = Math.min(...bands.map(([lo]) => lo)) - RIM_Z_TOLERANCE;
  const zMax = Math.max(...bands.map(([, hi]) => hi)) + RIM_Z_TOLERANCE;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, d] = [t[i], t[i + 1], t[i + 2]];
    const za = p[a * 3 + 2];
    const zb = p[b * 3 + 2];
    const zd = p[d * 3 + 2];
    if (Math.min(za, zb, zd) < zMin || Math.max(za, zb, zd) > zMax) continue;
    // The face's slope: |nz| of the unit normal -- 0.71 on a 45 degree band, 0 on a vertical wall, 1 on a flat face.
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = zb - za;
    const vx = p[d * 3] - p[a * 3];
    const vy = p[d * 3 + 1] - p[a * 3 + 1];
    const vz = zd - za;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const slope = Math.abs(nz) / len;
    const zs = [za, zb, zd];
    const vs = [a, b, d];
    const onBand = (zLo: number, zHi: number, lowSquare: boolean, kind: "chamfer" | "land"): boolean =>
      zs.every((z, k) => {
        if (kind === "land") return z >= (lowSquare ? zLo : zLo + c) - RIM_Z_TOLERANCE && z <= zHi - c + RIM_Z_TOLERANCE && Math.abs(offsetOf(vs[k]) - margin) < RIM_TOLERANCE;
        const up = lowSquare ? Infinity : z - zLo; // the bottom chamfer's height above the face
        const down = zHi - z; // the top chamfer's depth below the face
        const rise = up <= c + RIM_Z_TOLERANCE && down > c ? up : down <= c + RIM_Z_TOLERANCE && up > c ? down : -1;
        return rise >= -RIM_Z_TOLERANCE && Math.abs(offsetOf(vs[k]) - (margin - c + rise)) < RIM_TOLERANCE;
      });
    if (slope < 0.2 && bands.some(([lo, hi, sq]) => onBand(lo, hi, sq ?? false, "land"))) land.push(i / 3);
    else if (slope > 0.55 && slope < 0.85 && bands.some(([lo, hi, sq]) => onBand(lo, hi, sq ?? false, "chamfer"))) chamfer.push(i / 3);
  }
  return chamfer.length + land.length === 0 ? undefined : { chamfer: new Uint32Array(chamfer), land: new Uint32Array(land) };
}
