// Clip mount plate layout (issue #14, docs/research.md §1 "Wall mounting" +
// §10b "SKÅDIS clip"): a SEPARATE named part that glues or snaps onto the
// bottom flange's outer (wall-facing) face -- the SAME face mount.ts's
// screw-keyhole slots cut into (issue #13) -- so the core keeps printing
// flat with no clip features of its own. Pure geometry math only, shared by
// both geometry backends (manifold.ts's mesh cut/build and step/build.ts's
// solid ops), exactly mirroring mount.ts's own "one shared layout, two
// backends" principle.
//
// Grid mounts (SKÅDIS 40mm, openGrid 28mm -- see constants.ts) repeat their
// hole/slot pattern indefinitely, so only the SPACING between adjacent clips
// has to land exactly on the grid pitch; the plate's absolute position on a
// real board is never known at design time (the user simply slides the
// printed plate along the board until the holes line up), so this module is
// free to center the grid on the plate's own local origin.
//
// Coordinate convention ("up"/"side", mount.ts's WALL_UP-aligned axis, same
// as test/design.test.ts's own `project` helper for the keyhole mount):
//   upVec  = (sin(axisDeg), cos(axisDeg))
//   sideVec = (cos(axisDeg), -sin(axisDeg))
// an orthonormal basis (so `toXY`/`project` below are exact mutual
// inverses), chosen -- like mount.ts's `bestAxisDeg` -- so the shape is
// mirror-symmetric about `side=0` at this particular axisDeg: candidate grid
// points are placed and fit-checked directly in this rotated frame, never
// against a plain axis-aligned bounding box (which would wrongly assume a
// non-round outline is equally wide along a diagonal as along its own axes).
//
// Half-widths/extents are found by sampling the TRUE outline boundary
// (`shapes.ts`'s `pointAt`) and interpolating where it crosses a target
// `up` value, rather than reusing mount.ts's angle-only `radiusAtAngle`:
// that function answers "how far is the boundary along one ray from the
// origin", which only equals "how wide is the shape at up=U" for U=0 (a
// row through the centre) -- any other row needs the boundary's actual
// crossing, which this module computes directly and robustly for any
// convex outline.

import {
  MOUNT_PLATE_EDGE_MARGIN,
  MOUNT_PLATE_MAX_PER_SIDE,
  MOUNT_PLATE_MIN_CLIPS,
  OPENGRID_PLACEHOLDER_PEG_SIZE,
  SKADIS_CLIP_PROFILE,
  SKADIS_CLIP_WIDTH,
} from "./constants";
import { bestAxisDeg } from "./mount";
import { offsetOutline, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";

/** One clip/connector instance, in TRUE (x, y) flange-plane coordinates, mm. */
export interface ClipInstance {
  x: number;
  y: number;
  /**
   * True for the row with the greatest `up` value only (issue #14 AC:
   * "chamfer the lower rows at 45"): that row alone gets the fully-exposed,
   * unchamfered profile (constants.ts's `SKADIS_CLIP_PROFILE`); every other
   * row uses the chamfered variant. Always true when there is only one row.
   */
  topmost: boolean;
  /** The Z-axis rotation (degrees) that maps a clip built in its own canonical local frame (local +X = "up", local +Y = "side") onto this layout's true up/side axes -- see the file header. Identical for every clip in one layout. */
  rotationDeg: number;
}

/** One alignment peg (glue joint) or snap-tab (snap joint) anchor point, in TRUE (x, y) flange-plane coordinates -- always placed symmetric about `side=0`. */
export interface AnchorPoint {
  x: number;
  y: number;
  rotationDeg: number;
}

export interface MountPlateLayout {
  /** The plate's own footprint: a uniform inward offset of the flange's outline, always strictly inside it (issue #14 AC: "the plate must fit inside the flange outline"). */
  outline: ShapeOutline;
  clips: ClipInstance[];
  /** 2 pegs/tabs, symmetric about `side=0`; empty when the annulus is too narrow to fit them (the plate can still be glued flat without alignment aids). */
  anchors: AnchorPoint[];
  /** The `bestAxisDeg` theta this layout's rows/columns are actually aligned to (undefined only when `clips` is empty). Mirrors mount.ts's `MountLayout.axisDeg`. */
  axisDeg?: number;
  /** Set (with an empty `clips`) when the flange annulus is too narrow to fit at least `MOUNT_PLATE_MIN_CLIPS` clips. */
  warning?: string;
}

function basisFor(axisDeg: number) {
  const a = (axisDeg * Math.PI) / 180;
  const upVec = { x: Math.sin(a), y: Math.cos(a) };
  const sideVec = { x: Math.cos(a), y: -Math.sin(a) };
  return {
    toXY: (up: number, side: number) => ({ x: up * upVec.x + side * sideVec.x, y: up * upVec.y + side * sideVec.y }),
    project: (p: { x: number; y: number }) => ({ up: p.x * upVec.x + p.y * upVec.y, side: p.x * sideVec.x + p.y * sideVec.y }),
  };
}

const BOUNDARY_SAMPLES = 512;

/** Every boundary point of `outline` (offset 0), projected into (up, side) via `basisFor(axisDeg)` -- the shared sample set `rowExtent`/`halfWidthAtUp` both scan. */
function projectedBoundary(outline: ShapeOutline, axisDeg: number): Array<{ up: number; side: number }> {
  const { project } = basisFor(axisDeg);
  const pts: Array<{ up: number; side: number }> = [];
  for (let i = 0; i <= BOUNDARY_SAMPLES; i++) {
    const t = (i % BOUNDARY_SAMPLES) / BOUNDARY_SAMPLES;
    const p = pointAt(outline, t, 0);
    pts.push(project(p));
  }
  return pts;
}

/** [min, max] of the outline's own "up" coordinate over its whole boundary. */
function upExtent(boundary: Array<{ up: number; side: number }>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of boundary) {
    if (p.up < lo) lo = p.up;
    if (p.up > hi) hi = p.up;
  }
  return [lo, hi];
}

/** The farthest boundary crossing's |side| at the given `up0` (0 when the outline's up-range doesn't reach `up0` at all). Robust for any convex (or, conservatively, non-convex) outline: scans every boundary segment for an up=up0 crossing and linearly interpolates `side` there. */
function halfWidthAtUp(boundary: Array<{ up: number; side: number }>, up0: number): number {
  let maxSide = 0;
  for (let i = 0; i < boundary.length - 1; i++) {
    const a = boundary[i];
    const b = boundary[i + 1];
    const lo = Math.min(a.up, b.up);
    const hi = Math.max(a.up, b.up);
    if (up0 < lo || up0 > hi || hi - lo < 1e-9) continue;
    const frac = (up0 - a.up) / (b.up - a.up);
    const side = Math.abs(a.side + frac * (b.side - a.side));
    if (side > maxSide) maxSide = side;
  }
  return maxSide;
}

/**
 * Lay out a grid of clip instances (and, if they fit, 2 alignment
 * anchors) on the plate's own footprint. `flangeOutline`/`boreOutline`
 * mirror manifold.ts's `FlangeSpec` (the flange's own true outer outline,
 * already offset out by its margin, and its bore), so the mesh and STEP
 * backends compute the identical layout from identical inputs.
 *
 * `clipHalfSide`/`clipHalfUp` are the clip footprint's own half-extents (mm)
 * along each local axis -- different per mount kind (SKÅDIS's mirrored hook
 * vs. openGrid's placeholder peg, see constants.ts) -- and `pitch` is that
 * kind's own grid spacing (SKADIS_PITCH/OPENGRID_PITCH).
 */
export function layoutMountPlate(
  flangeOutline: ShapeOutline,
  boreOutline: ShapeOutline,
  pitch: number,
  clipHalfSide: number,
  clipHalfUp: number,
): MountPlateLayout {
  const outline = offsetOutline(flangeOutline, -MOUNT_PLATE_EDGE_MARGIN);
  if (outline.apothem <= 1 || outline.cornerRadius < 0) {
    return { outline, clips: [], anchors: [], warning: "The flange is too small to fit a mount plate at all." };
  }

  const axisDeg = bestAxisDeg(boreOutline, 0);
  const rotationDeg = 90 - axisDeg; // see the file header: maps a clip's canonical local frame onto this layout's up/side axes
  const { toXY } = basisFor(axisDeg);
  const boundary = projectedBoundary(outline, axisDeg);
  const [minUp, maxUp] = upExtent(boundary);

  const rowsUp: number[] = [0];
  for (let k = 1; k <= MOUNT_PLATE_MAX_PER_SIDE && k * pitch <= maxUp - clipHalfUp; k++) rowsUp.push(k * pitch);
  for (let k = 1; k <= MOUNT_PLATE_MAX_PER_SIDE && -k * pitch >= minUp + clipHalfUp; k++) rowsUp.push(-k * pitch);

  // Keep only rows that fit at least MOUNT_PLATE_MIN_CLIPS/2 columns on
  // each side (i.e. at least 1 pitch-step) -- a row too narrow for a
  // symmetric pair is dropped rather than emitted half-populated.
  const rows = rowsUp
    .map((up) => ({ up, colSteps: Math.min(MOUNT_PLATE_MAX_PER_SIDE, Math.floor((halfWidthAtUp(boundary, up) - clipHalfSide) / pitch)) }))
    .filter((r) => r.colSteps >= 1);

  if (rows.length === 0) {
    return {
      outline,
      clips: [],
      anchors: [],
      warning: `The flange is too small to fit at least ${MOUNT_PLATE_MIN_CLIPS} clips on the ${pitch} mm grid (increase the core size, or the mount plate was skipped).`,
    };
  }

  const topmostUp = Math.max(...rows.map((r) => r.up));
  const clips: ClipInstance[] = [];
  for (const row of rows) {
    for (let k = 1; k <= row.colSteps; k++) {
      for (const side of [k * pitch, -k * pitch]) {
        const { x, y } = toXY(row.up, side);
        clips.push({ x, y, topmost: row.up === topmostUp, rotationDeg });
      }
    }
  }

  // 2 alignment pegs/snap-tabs, on the side axis through the centre (up=0),
  // at the midpoint of the annulus between the bore and the plate's own
  // edge (mirrors mount.ts's `slotAt` band-midpoint placement) -- purely a
  // best-effort placement aid; the plate is still a valid, glueable part
  // without them if the annulus is too narrow.
  const boreHalfWidthAt0 = halfWidthAtUp(projectedBoundary(boreOutline, axisDeg), 0);
  const outerHalfWidthAt0 = halfWidthAtUp(boundary, 0);
  const innerLimit = boreHalfWidthAt0 + 1;
  const outerLimit = outerHalfWidthAt0 - 1;
  const anchors: AnchorPoint[] =
    innerLimit < outerLimit
      ? [(innerLimit + outerLimit) / 2, -(innerLimit + outerLimit) / 2].map((side) => ({ ...toXY(0, side), rotationDeg }))
      : [];

  return { outline, clips, anchors, axisDeg };
}

/** The SKÅDIS hook's own half-extents (mm): `halfUp` from the profile's own farthest point (constants.ts's `SKADIS_CLIP_PROFILE`, mirrored about up=0 -- see the file header), `halfSide` from its extrusion width. Computed from the profile data itself (not a separately hand-maintained constant), so it can never silently drift from the actual geometry manifold.ts/step/build.ts build. */
export function skadisClipHalfExtents(): { halfUp: number; halfSide: number } {
  return { halfUp: Math.max(...SKADIS_CLIP_PROFILE.map(([u]) => u)), halfSide: SKADIS_CLIP_WIDTH / 2 };
}

/** The openGrid placeholder connector's half-extents (mm) -- see constants.ts's `OPENGRID_PLACEHOLDER_PEG_SIZE` TODO. */
export function openGridClipHalfExtents(): { halfUp: number; halfSide: number } {
  return { halfUp: OPENGRID_PLACEHOLDER_PEG_SIZE / 2, halfSide: OPENGRID_PLACEHOLDER_PEG_SIZE / 2 };
}
