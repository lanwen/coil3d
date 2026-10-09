import { EDGE_CHAMFER } from "./constants";
import { outlineOffsetAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh } from "./types";

export interface RimRow {
  offset: number;
  z: number;
}

export function chamferedRim(margin: number, zLo: number, zHi: number): RimRow[] {
  const c = EDGE_CHAMFER;
  return [
    { offset: margin - c, z: zLo },
    { offset: margin, z: zLo + c },
    { offset: margin, z: zHi - c },
    { offset: margin - c, z: zHi },
  ];
}

const WEDGE_CLEARANCE_BELOW_FOOT = 1;

export function chamferWedgeRows(margin: number, zFace: number, zBelow: number = zFace - EDGE_CHAMFER - WEDGE_CLEARANCE_BELOW_FOOT): [RimRow, RimRow] {
  const c = EDGE_CHAMFER;
  return [
    { offset: margin - c + (zFace - zBelow), z: zBelow },
    { offset: margin - c, z: zFace },
  ];
}

export const SLAB_BELOW_FACE = EDGE_CHAMFER + 0.25;

const RIM_SURFACE_TOLERANCE = 0.15;
const RIM_PLANE_TOLERANCE = 0.02;
const DEGENERATE_NORMAL_LENGTH = 1e-12;
const LAND_MAX_SLOPE = 0.2;
const CHAMFER_MIN_SLOPE = 0.55;
const CHAMFER_MAX_SLOPE = 0.85;

type Corner = { vertex: number; z: number };

function faceSlope(p: Float32Array, [a, b, d]: Corner[]): number | undefined {
  const ux = p[b.vertex * 3] - p[a.vertex * 3];
  const uy = p[b.vertex * 3 + 1] - p[a.vertex * 3 + 1];
  const uz = b.z - a.z;
  const vx = p[d.vertex * 3] - p[a.vertex * 3];
  const vy = p[d.vertex * 3 + 1] - p[a.vertex * 3 + 1];
  const vz = d.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len < DEGENERATE_NORMAL_LENGTH ? undefined : Math.abs(nz) / len;
}

export function rimTriangles(mesh: CoilMesh, outline: ShapeOutline, margin: number, bands: Array<[number, number]>): CoilMesh["rimTriangles"] {
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
  const onLand = (corners: Corner[], zLo: number, zHi: number): boolean =>
    corners.every(({ vertex, z }) => z >= zLo + c - RIM_PLANE_TOLERANCE && z <= zHi - c + RIM_PLANE_TOLERANCE && Math.abs(offsetOf(vertex) - margin) < RIM_SURFACE_TOLERANCE);
  const onChamfer = (corners: Corner[], zLo: number, zHi: number): boolean =>
    corners.every(({ vertex, z }) => {
      const up = z - zLo;
      const down = zHi - z;
      const rise = up <= c + RIM_PLANE_TOLERANCE && down > c ? up : down <= c + RIM_PLANE_TOLERANCE && up > c ? down : -1;
      return rise >= -RIM_PLANE_TOLERANCE && Math.abs(offsetOf(vertex) - (margin - c + rise)) < RIM_SURFACE_TOLERANCE;
    });
  const zMin = Math.min(...bands.map(([lo]) => lo)) - RIM_PLANE_TOLERANCE;
  const zMax = Math.max(...bands.map(([, hi]) => hi)) + RIM_PLANE_TOLERANCE;
  for (let i = 0; i < t.length; i += 3) {
    const corners = [t[i], t[i + 1], t[i + 2]].map((vertex) => ({ vertex, z: p[vertex * 3 + 2] }));
    const zs = corners.map(({ z }) => z);
    if (Math.min(...zs) < zMin || Math.max(...zs) > zMax) continue;
    const slope = faceSlope(p, corners);
    if (slope === undefined) continue;
    if (slope < LAND_MAX_SLOPE && bands.some(([lo, hi]) => onLand(corners, lo, hi))) land.push(i / 3);
    else if (slope > CHAMFER_MIN_SLOPE && slope < CHAMFER_MAX_SLOPE && bands.some(([lo, hi]) => onChamfer(corners, lo, hi))) chamfer.push(i / 3);
  }
  return chamfer.length + land.length === 0 ? undefined : { chamfer: new Uint32Array(chamfer), land: new Uint32Array(land) };
}
