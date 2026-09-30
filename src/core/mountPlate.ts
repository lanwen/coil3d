// Clip mount plate layout (issue #14, docs/research.md §1 "Wall mounting" +
// §10b "SKÅDIS clip", §10d issue #106 fit check): a SEPARATE named part
// that glues (on two printed alignment pegs, issue #132) onto the bottom flange's outer
// (wall-facing) face -- the SAME face mount.ts's screw-keyhole slots cut
// into (issue #13) -- so the core keeps printing flat with no clip features
// of its own. Pure geometry math only, shared by both geometry backends
// (manifold.ts's mesh cut/build and step/build.ts's solid ops), exactly
// mirroring mount.ts's own "one shared layout, two backends" principle.
//
// Grid mounts (SKÅDIS, openGrid 28mm -- see constants.ts) repeat their
// hole/slot pattern indefinitely, so only the VECTOR between any two clips
// has to be one of the board's own lattice vectors; the plate's absolute position on a
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
  MOUNT_PLATE_PEG_CORNER,
  MOUNT_PLATE_PEG_LEAD_IN,
  MOUNT_PLATE_PEG_LENGTH,
  MOUNT_PLATE_PEG_RADIUS,
  MOUNT_PLATE_PEG_SIZE,
  MOUNT_PLATE_THICKNESS,
  OPENGRID_PITCH,
  OPENGRID_PLACEHOLDER_PEG_SIZE,
  SKADIS_BOARD_THICKNESS,
  SKADIS_CLIP_HEIGHT,
  SKADIS_CLIP_PROFILE,
  SKADIS_LATTICE_STEP,
  SKADIS_PITCH,
  SKADIS_SLOT_LENGTH,
  SKADIS_SLOT_WIDTH,
} from "./constants";
import { bestAxisDeg } from "./mount";
import { offsetOutline, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { SweepSolid } from "./innerEnd";
import type { PegboardSection } from "./types";

/** One clip/connector instance, in TRUE (x, y) flange-plane coordinates, mm. */
export interface ClipInstance {
  x: number;
  y: number;
  /** The Z-axis rotation (degrees) that maps a clip built in its own canonical local frame (local +X = "up", local +Y = "side") onto this layout's true up/side axes -- see the file header. Identical for every clip in one layout. */
  rotationDeg: number;
}

/** One peg hole pair (a blind hole in the plate's front face plus a matching one in the flange, joined by one printed peg -- constants.ts's MOUNT_PLATE_PEG_*), in TRUE (x, y) flange-plane coordinates -- always placed symmetric about `side=0`. */
export interface AnchorPoint {
  x: number;
  y: number;
  rotationDeg: number;
}

export interface MountPlateLayout {
  /** The plate's own footprint: a uniform inward offset of the flange's outline, always strictly inside it (issue #14 AC: "the plate must fit inside the flange outline"). */
  outline: ShapeOutline;
  clips: ClipInstance[];
  /** 2 peg holes, symmetric about `side=0`; empty when the annulus is too narrow to fit them (the plate can still be glued flat without alignment aids). */
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

/** What the pin holes must keep clear of: the footprint of the flange's inner-end channel and clip (innerEnd.ts's `InnerEndLayout.channelRibbon`). */
export interface InnerEndKeepOut {
  channelRibbon: Array<{ x: number; y: number }>;
}
/** Minimum distance from a peg hole's centre to the channel's outline (mm): the hole's own radius plus a wall. */
const ANCHOR_KEEP_OUT = MOUNT_PLATE_PEG_RADIUS + 1.5;

/** The round peg hole's radius (issue #132): the circle through the peg's corners plus half the print tolerance, so the fit's clearance across the corners is the tolerance itself. */
export function pegHoleRadius(tolerance: number): number {
  return MOUNT_PLATE_PEG_RADIUS + tolerance / 2;
}

/**
 * One alignment peg (issue #132, constants.ts's MOUNT_PLATE_PEG_*) as a
 * swept solid: 4 octagonal rings along the peg's own axis, which stands in
 * `anchor`'s hole along Z, centred on the plate/flange seam at `zSeam`. The
 * end rings are inset by the lead-in, so both ends are 45 degree chamfers.
 * The flats face +-X/+-Y, so the print pose (lying down, rotated about X)
 * rests on a wide flat. The same rings build the mesh (innerEnd.ts's
 * `sweepMesh`) and the STEP solid.
 */
export function pegSweep(anchor: { x: number; y: number }, zSeam: number): SweepSolid {
  const octagon = (inset: number, z: number) => {
    const h = MOUNT_PLATE_PEG_SIZE / 2 - inset;
    const k = MOUNT_PLATE_PEG_SIZE - MOUNT_PLATE_PEG_CORNER - inset * Math.SQRT2; // the 45 degree flats lie on |x| + |y| = k
    const corners: Array<[number, number]> = [
      [h, k - h], [k - h, h], [h - k, h], [-h, k - h], [-h, h - k], [h - k, -h], [k - h, -h], [h, h - k],
    ];
    return corners.map(([x, y]) => ({ x: anchor.x + x, y: anchor.y + y, z }));
  };
  const z0 = zSeam - MOUNT_PLATE_PEG_LENGTH / 2;
  const z1 = zSeam + MOUNT_PLATE_PEG_LENGTH / 2;
  const c = MOUNT_PLATE_PEG_LEAD_IN;
  return {
    rings: [octagon(c, z0), octagon(0, z0 + c), octagon(0, z1 - c), octagon(c, z1)],
    start: { x: anchor.x, y: anchor.y, z: z0 },
    end: { x: anchor.x, y: anchor.y, z: z1 },
  };
}

/** Distance from `p` to the nearest edge of a closed polygon. */
function distanceToPolygon(p: { x: number; y: number }, points: Array<{ x: number; y: number }>): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    // Issue #115: a point INSIDE the polygon is at distance 0, not at its
    // distance to the nearest edge (the inner-end channel is now a long,
    // wide strip that a pin can land in the middle of).
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return inside ? 0 : best;
}

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

/** The farthest boundary crossing at `up0` on each side of `side=0` (`pos` >= 0, `neg` >= 0 its distance on the negative side; 0 where the outline doesn't reach). */
function edgesAtUp(boundary: Array<{ up: number; side: number }>, up0: number): { pos: number; neg: number } {
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < boundary.length - 1; i++) {
    const a = boundary[i];
    const b = boundary[i + 1];
    const lo = Math.min(a.up, b.up);
    const hi = Math.max(a.up, b.up);
    if (up0 < lo || up0 > hi || hi - lo < 1e-9) continue;
    const side = a.side + ((up0 - a.up) / (b.up - a.up)) * (b.side - a.side);
    if (side > pos) pos = side;
    if (-side > neg) neg = -side;
  }
  return { pos, neg };
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
 *
 * `columnOffset` (issue #106): columns sit at side = +-(columnOffset +
 * k*pitch), rows at up = n*pitch. A plain rectangular 40 mm grid is one of
 * SKÅDIS's two interleaved 40 mm grids (constants.ts's "SKÅDIS board
 * facts"), so every clip-to-clip vector lands on the board's lattice.
 * Offsetting the columns by half a pitch (20 mm) keeps the layout mirrored
 * about side=0 with the two middle columns exactly 40 mm apart, and fits a
 * flange about half as wide as columns at +-40 would. 0 puts the columns at
 * +-k*pitch (k >= 1), the plain grid openGrid uses. (The issue #14 layout
 * instead staggered every other 40 mm column by 20 mm vertically, which put
 * the +-40 and +-80 columns on different grids: a real board has no slots
 * there.)
 */
export function layoutMountPlate(
  flangeOutline: ShapeOutline,
  boreOutline: ShapeOutline,
  pitch: number,
  clipHalfSide: number,
  clipHalfUp: number,
  columnOffset = 0,
  /** The footprint of the flange's inner-end channel and clip (innerEnd.ts's `layoutInnerEnd`), which the pin holes must stay clear of. */
  avoid?: InnerEndKeepOut,
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

  /** Is a clip footprint centred at this exact (up, side) point genuinely inside the outline (not just within a shared, possibly-optimistic row/column budget)? Checked directly against the boundary so no clip lands outside a non-round outline. */
  const fits = (up: number, side: number): boolean =>
    up >= minUp + clipHalfUp &&
    up <= maxUp - clipHalfUp &&
    Math.min(halfWidthAtUp(boundary, up - clipHalfUp), halfWidthAtUp(boundary, up), halfWidthAtUp(boundary, up + clipHalfUp)) - clipHalfSide >= Math.abs(side);

  // Mirrored column pairs (see `columnOffset` above), every row on the same
  // `pitch` grid through up=0.
  const clips: ClipInstance[] = [];
  for (let k = 0; k < MOUNT_PLATE_MAX_PER_SIDE; k++) {
    const side = columnOffset > 0 ? columnOffset + k * pitch : (k + 1) * pitch;
    const rowsUp = [0];
    for (let n = 1; n <= MOUNT_PLATE_MAX_PER_SIDE; n++) rowsUp.push(n * pitch, -n * pitch);
    for (const up of rowsUp) {
      if (!fits(up, side)) continue;
      for (const s of [side, -side]) clips.push({ ...toXY(up, s), rotationDeg });
    }
  }

  if (clips.length === 0) {
    return {
      outline,
      clips: [],
      anchors: [],
      warning: `The flange is too small to fit at least ${MOUNT_PLATE_MIN_CLIPS} clips on the ${pitch} mm grid (increase the core size, or the mount plate was skipped).`,
    };
  }

  // 2 alignment peg holes, at the midpoint of the annulus between the bore
  // and the plate's own edge (mirrors mount.ts's `slotAt` band-midpoint
  // placement): on the side axis through the centre (up=0), or -- when that
  // would cut into the flange's own inner-end channel or clip (issue
  // #106: a pin hole grazing the old keyhole's through-cut added a tunnel) --
  // on the up axis instead. Purely a best-effort placement aid; the plate
  // is still a valid, glueable part without them.
  const pairOn = (turnDeg: 0 | 90): AnchorPoint[] => {
    // Issue #132: each hole at the middle of ITS OWN side's annulus -- a
    // triangle is much shorter from its centre to a flat than to the
    // opposite corner, so one shared (farther-side) distance put the hole on
    // the flat's side outside the plate (unseen with a filament pin, a
    // floating peg now).
    const bore = edgesAtUp(projectedBoundary(boreOutline, axisDeg + turnDeg), 0);
    const edge = edgesAtUp(projectedBoundary(outline, axisDeg + turnDeg), 0);
    const mids: number[] = [];
    for (const [inner, outer, sign] of [[bore.pos + 1, edge.pos - 1, 1], [bore.neg + 1, edge.neg - 1, -1]]) {
      if (outer - inner < 2 * MOUNT_PLATE_PEG_RADIUS) return [];
      mids.push((sign * (inner + outer)) / 2);
    }
    // The turned frame's +side is this frame's -up (`basisFor`).
    const pts = mids.map((m) => (turnDeg === 0 ? toXY(0, m) : toXY(-m, 0)));
    return pts.map((p) => ({ ...p, rotationDeg }));
  };
  const clear = (p: { x: number; y: number }) =>
    !avoid || avoid.channelRibbon.length < 3 || distanceToPolygon(p, avoid.channelRibbon) >= ANCHOR_KEEP_OUT;
  const anchors = [pairOn(0), pairOn(90)].find((pair) => pair.length === 2 && pair.every(clear)) ?? [];

  return { outline, clips, anchors, axisDeg };
}

/** The SKÅDIS clip pair's own half-extents (mm): `halfUp` from half its length along WALL_UP (constants.ts's `SKADIS_CLIP_HEIGHT`), `halfSide` from the profile's own farthest sideways point (the barb). Computed from the profile data itself, so it can't drift from the geometry manifold.ts/step/build.ts build. */
export function skadisClipHalfExtents(): { halfUp: number; halfSide: number } {
  return { halfUp: SKADIS_CLIP_HEIGHT / 2, halfSide: Math.max(...SKADIS_CLIP_PROFILE.map(([s]) => s)) };
}

/**
 * How far a clip's centre sits BELOW its slot's centre once seated (mm):
 * the plate hangs on its clips, and each leg's outer bottom corner rests on
 * the slot's rounded bottom end, r - sqrt(r^2 - w^2) above the slot's very
 * bottom (slot half-width r, leg half-width w -- the profile's second point).
 */
export function skadisSeatDrop(slotWidth: number, slotLength: number): number {
  const r = slotWidth / 2;
  const w = SKADIS_CLIP_PROFILE[1][0];
  const rest = r - Math.sqrt(r * r - w * w);
  return slotLength / 2 - rest - SKADIS_CLIP_HEIGHT / 2;
}

/**
 * The nominal SKÅDIS board the plate hangs on, clips seated (issue #106):
 * every lattice slot (constants.ts's "SKÅDIS board facts": centres at
 * (20a, 20b) mm with a + b even, relative to the first clip's own slot)
 * whose centre lies within `radius` of the plate's centre. For the viewer
 * and guide to draw the slot grid against the clips; the fit itself is
 * checked in test/mountPlate.test.ts against a board built from the facts
 * alone.
 */
export function skadisBoard(layout: MountPlateLayout, flangeThickness: number, radius: number): PegboardSection | undefined {
  if (layout.axisDeg === undefined || layout.clips.length === 0) return undefined;
  const { toXY, project } = basisFor(layout.axisDeg);
  const drop = skadisSeatDrop(SKADIS_SLOT_WIDTH, SKADIS_SLOT_LENGTH);
  const origin = project(layout.clips[0]);
  const step = SKADIS_LATTICE_STEP;
  const n = Math.ceil((radius + Math.hypot(origin.side, origin.up)) / step) + 1;
  const slots: Array<{ x: number; y: number }> = [];
  for (let a = -n; a <= n; a++) {
    for (let b = -n; b <= n; b++) {
      if (Math.abs(a + b) % 2 !== 0) continue;
      const side = origin.side + a * step;
      const up = origin.up + drop + b * step;
      if (Math.hypot(side, up) > radius) continue;
      slots.push(toXY(up, side));
    }
  }
  return {
    slots,
    slotWidth: SKADIS_SLOT_WIDTH,
    slotLength: SKADIS_SLOT_LENGTH,
    thickness: SKADIS_BOARD_THICKNESS,
    frontZ: -flangeThickness - MOUNT_PLATE_THICKNESS,
    axisDeg: layout.axisDeg,
  };
}

/** The openGrid placeholder connector's half-extents (mm) -- see constants.ts's `OPENGRID_PLACEHOLDER_PEG_SIZE` TODO. */
export function openGridClipHalfExtents(): { halfUp: number; halfSide: number } {
  return { halfUp: OPENGRID_PLACEHOLDER_PEG_SIZE / 2, halfSide: OPENGRID_PLACEHOLDER_PEG_SIZE / 2 };
}

/** The one layout both geometry backends (design.ts's mesh, step/build.ts's solid) build from, per mount kind: SKÅDIS on its 40 mm grid with the columns half a pitch off-centre (see `layoutMountPlate`'s `columnOffset`), openGrid on its plain 28 mm grid. `flangeOutline` is the flange's true outer outline (already offset by its margin). */
export function mountPlateLayoutFor(mountKind: "skadis" | "opengrid", flangeOutline: ShapeOutline, boreOutline: ShapeOutline, avoid?: InnerEndKeepOut): MountPlateLayout {
  if (mountKind === "skadis") {
    const { halfSide, halfUp } = skadisClipHalfExtents();
    return layoutMountPlate(flangeOutline, boreOutline, SKADIS_PITCH, halfSide, halfUp, SKADIS_PITCH / 2, avoid);
  }
  const { halfSide, halfUp } = openGridClipHalfExtents();
  return layoutMountPlate(flangeOutline, boreOutline, OPENGRID_PITCH, halfSide, halfUp, 0, avoid);
}

/**
 * The minimum flange margin that lets `mountPlateLayoutFor` place at least
 * `MOUNT_PLATE_MIN_CLIPS` clips (issue #120): mirrors mount.ts's own
 * `requiredFlangeMargin` (keyhole) and `requiredThroughMountMargin`
 * (through-hole) -- flange.ts's `resolveFlangeSizing` already grows the
 * flange margin for THOSE two mount kinds so the mount is never silently
 * skipped just because the auto-solved core came out small, "no ceiling:
 * even a tiny, sharp core gets a flange grown just wide enough to fit the
 * mount" (e2e/mount.spec.ts). SKÅDIS/openGrid had no equivalent -- their
 * margin only ever grew for the plain wound-envelope clearance, never for
 * the plate's own fixed-pitch grid, so a solver-picked (or just small,
 * locked) core could come out smaller than 1 pitch step and silently drop
 * the whole plate with only a general warning to notice by (the reported
 * bug: a solver-picked core small enough that even 2 clips, mirrored at the
 * FIRST/cheapest row -- `up=0`, where every outline is widest, see this
 * file's own header on why `up=0` is the one row `radiusAtAngle` actually
 * gets right -- can't clear the flange edge).
 *
 * Found by bisection over `layoutMountPlate`'s own REAL clip count -- not a
 * closed form, unlike the keyhole slot's single-ray `radiusAtAngle` check:
 * a clip's own footprint is offset in the "up" direction too (`clipHalfUp`
 * on either side of `up=0`), where `radiusAtAngle` is NOT exact for a
 * non-round outline (this file's own header), so this checks the actual
 * layout at each trial margin, exactly like the fit it's guaranteeing.
 * `layoutMountPlate` only ever returns 0 or (by construction, every
 * position is placed as a mirrored `+-side` pair) an even number >=
 * `MOUNT_PLATE_MIN_CLIPS` of clips, so "at least one clip" and "at least
 * `MOUNT_PLATE_MIN_CLIPS`" are the same bisection target.
 */
export function requiredMountPlateMargin(outline: ShapeOutline, boreOutline: ShapeOutline, mountKind: "skadis" | "opengrid"): number {
  const fits = (margin: number): boolean => mountPlateLayoutFor(mountKind, offsetOutline(outline, margin), boreOutline).clips.length > 0;
  let lo = 0;
  let hi = 1;
  while (!fits(hi)) hi *= 2;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  // A hairline (1e-6 mm) safety margin past the bare-minimum target, same
  // convention as mount.ts's own bisections: floating-point rounding can
  // otherwise leave flange.ts's later, independent recomputation of this
  // SAME "does it fit" check a few ULPs short of the value this bisection
  // was solved against.
  return hi + 1e-6;
}
