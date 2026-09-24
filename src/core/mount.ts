// Screw-keyhole wall mount (issue #13, docs/research.md "Mounting": "screw
// keyhole (wall)", "the axis points out of the wall; mount features sit on
// the bottom flange's outer face"). Pure geometry math only -- no
// manifold-3d, no replicad -- so it is shared, unchanged, by BOTH backends
// (manifold.ts's mesh cut and step/build.ts's STEP cut), the same "two
// backends, one feature description" principle as wall.ts's WallProfile:
// the two must never place or size the slot(s) differently.
//
// Shape: a wide circle (screw-HEAD clearance) joined by a straight,
// shank-width channel to a second, narrower circle (where the shank rests
// once hung) -- the classic hardware-store "keyhole slot", not a smoothly
// tapered capsule: real keyhole hangers step down abruptly from the head
// opening to a narrower rail, which is also simpler to build identically in
// manifold-3d (2 cylinders + an extruded rectangle) and replicad (2 circles
// + a drawn rectangle, unioned in 2D then extruded once).
//
// Mounting mechanics: the user inserts the screw through the wide (head)
// circle, then lowers the part -- so, in the PART's own local frame, the
// screw's position moves from the head circle UP the channel to the narrow
// end, where it seats and gravity holds it against the material above (the
// flange's own remaining thickness there is the load-bearing "roof" --
// design.ts's MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT). Both slots' channels run
// PARALLEL (not radially fanning out from the flange's centre): the whole
// part is rigid, so for a 2-slot layout to hang level, both channels must
// already point the same way in-frame -- a radial fan can't both be
// vertical at once after installing.
//
// "Up", explicitly (this is the one axis every other piece of this feature
// is defined against -- see WALL_UP below): local +Y at angle 0 in the
// `makeSlotAt` convention (x = R*sin(theta), y = R*cos(theta), theta
// measured from local +Y, i.e. `theta = 90 - standardAngleDeg`). CoilViewer.
// tsx's wall-mount preset rotates the viewed geometry so this SAME axis
// (local +Y) lands on the camera's own up vector -- so what this module
// calls "up" is what the viewer shows as up. The slot(s) sit ABOVE the
// centre (positive y) with the narrow (shankEnd) end further up than the
// head end, per the mechanics above.
//
// Placement: a 2-slot layout only hangs level if the two slots sit
// symmetric about an axis the shape is ACTUALLY mirror-symmetric about, and
// the centre of mass (the outline's own centre) must sit directly below the
// slot(s). shapes.ts's regular n-gon construction (evalOutline: corner i at
// standard angle 2*pi*i/n) has 2n such axis directions within reach of
// vertical -- n through a corner (and the opposite side's midpoint), and n
// through a side's midpoint (and the opposite corner) -- spaced 180/n
// degrees apart; round and square (n=4) have one of each exactly at
// vertical, but triangle (n=3, spaced 60 degrees apart) does not, and needs
// to tilt onto the nearest one (see `candidateAxisDegs`/`bestAxisDeg`).
//
// Among the reachable axes (`SCREW_MOUNT_AXIS_SEARCH_MAX_DEG` of vertical --
// the PR review's own suggested "+-30-45 degrees" range for the 2-slot
// case), this module doesn't just take the nearest to vertical: it picks
// whichever needs the LEAST flange margin, using shapes.ts's `radiusAtAngle`
// (the shape's EXACT boundary distance at that one specific angle, not the
// worst-case-anywhere `circumscribedRadius`). A side's own midpoint has NO
// bulge at all (`radiusAtAngle` there is just `apothem`, the same as round);
// a corner's own midpoint has the FULL bulge (`circumscribedRadius`) -- an
// earlier, angle-agnostic version of this budget always assumed the latter,
// which for a non-round shape can be so pessimistic the mount never fits at
// all (issue #13 PR review). Landing exactly on the cheapest axis isn't
// always the best choice once the 2-slot FAN is added on top of it, though
// (fanning away from an expensive corner can end up cheaper than fanning
// away from an already-cheap side -- both move by the same angle, but only
// one starts from the worse place), so the search evaluates every
// candidate's own FANNED position, not just its unfanned cost.

import {
  SCREW_MOUNT_ANNULUS_WIDTH,
  SCREW_MOUNT_AXIS_SEARCH_MAX_DEG,
  SCREW_MOUNT_EDGE_MARGIN,
  SCREW_MOUNT_HEAD_RADIUS,
  SCREW_MOUNT_RECESS_DEPTH,
  SCREW_MOUNT_SHANK_RADIUS,
  SCREW_MOUNT_SLOT_TRAVEL,
  SCREW_MOUNT_TWO_SLOT_ANGLE,
  SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD,
} from "./constants";
import { inscribedRadius, offsetOutline, radiusAtAngle } from "./shapes";
import type { ShapeOutline } from "./shapes";

/**
 * The explicit "up" direction for wall mounting, in the flange's own local
 * XY plane: local +Y. Every other "up" in this feature -- `makeSlotAt`'s
 * theta=0 below, and CoilViewer.tsx's WALL_VIEW_ROTATION, which maps this
 * SAME axis onto the camera's own up vector -- is defined relative to this
 * one constant, so the core and the viewer can never silently disagree
 * about which way is up.
 */
export const WALL_UP = { x: 0, y: 1 } as const;

/** `makeSlotAt`'s theta (degrees from WALL_UP) <-> shapes.ts's standard angle (radians from +X). */
function standardAngleRad(thetaDeg: number): number {
  return ((90 - thetaDeg) * Math.PI) / 180;
}

/**
 * Every corner's and every side-midpoint's own standard angle, converted to
 * `makeSlotAt` theta and normalised to (-180, 180], keeping only those
 * within `SCREW_MOUNT_AXIS_SEARCH_MAX_DEG` of vertical (theta=0) -- see the file
 * header. Each one is (one end of) a genuine mirror axis of the whole
 * outline, so placing a slot on it, or two slots symmetric about it, always
 * hangs level.
 */
function candidateAxisDegs(n: number): number[] {
  const stepDeg = 360 / n;
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const standardDeg of [i * stepDeg, i * stepDeg + stepDeg / 2]) {
      const theta = (((90 - standardDeg + 180) % 360) + 360) % 360 - 180;
      if (Math.abs(theta) <= SCREW_MOUNT_AXIS_SEARCH_MAX_DEG) candidates.push(theta);
    }
  }
  return candidates;
}

/**
 * Among the reachable axes, the one whose FANNED position (`axis +
 * fanDeg`, matching whatever a 2-slot layout will actually place a slot
 * at -- pass `fanDeg=0` for the single-slot case) sits closest to the
 * outline's own flat sides (the smallest `radiusAtAngle`), i.e. needs the
 * least flange margin to fit -- see the file header.
 */
export function bestAxisDeg(boreOutline: ShapeOutline, fanDeg: number): number {
  let best = 0;
  let bestRadius = Infinity;
  for (const theta of candidateAxisDegs(boreOutline.n)) {
    const r = radiusAtAngle(boreOutline, standardAngleRad(theta + fanDeg));
    // Prefer a strictly cheaper candidate, but break a (near-)tie -- e.g.
    // round, or any shape with no bulge to speak of, ties on EVERY
    // candidate -- by whichever sits closest to true vertical, so a
    // fully-agnostic shape still gets the visually obvious "top centre"
    // placement instead of an arbitrary, equally-valid-but-surprising tilt.
    const tied = Math.abs(r - bestRadius) < 1e-6;
    if (r < bestRadius - 1e-6 || (tied && Math.abs(theta) < Math.abs(best))) {
      bestRadius = r;
      best = theta;
    }
  }
  return best;
}

/**
 * The minimum flange margin that lets `layoutKeyholeMount` actually place a
 * slot (checked for both the single- and the 2-slot case, at each one's own
 * best axis -- design.ts doesn't know the slot count in advance, since that
 * itself depends on the flange's final, margin-grown size, so it needs one
 * number that works for either). Found by a binary search over margin
 * (`radiusAtAngle` isn't simply additive in margin off a corner or side's
 * own exact centre -- see the file header), not a closed form.
 */
export function requiredFlangeMargin(outline: ShapeOutline, boreOutline: ShapeOutline): number {
  const requiredAnnulusAt = (fanDeg: number): number => {
    const axis = bestAxisDeg(boreOutline, fanDeg);
    const phi = standardAngleRad(axis + fanDeg);
    const boreR = radiusAtAngle(boreOutline, phi);
    const target = boreR + SCREW_MOUNT_ANNULUS_WIDTH;

    const flangeRadiusAt = (margin: number) => radiusAtAngle(offsetOutline(outline, margin), phi);
    let lo = 0;
    let hi = 1;
    while (flangeRadiusAt(hi) < target) hi *= 2;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (flangeRadiusAt(mid) < target) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  return Math.max(requiredAnnulusAt(0), requiredAnnulusAt(SCREW_MOUNT_TWO_SLOT_ANGLE));
}

export interface KeyholeSlot {
  /** Centre of the wide, screw-head-insertion circle, in the flange's local XY (mm). */
  head: { x: number; y: number };
  /** Centre of the narrow circle at the far end of the channel, where the shank rests once hung (mm). */
  shankEnd: { x: number; y: number };
}

export interface MountLayout {
  slots: KeyholeSlot[];
  /** Depth of the pocket, cut inward from the flange's outer (wall-facing) face, mm. */
  recessDepth: number;
  /** Set (with an empty `slots`) when the flange annulus is too narrow to fit even a single slot. */
  warning?: string;
}

/**
 * Lay out 1-2 keyhole slots in the flange's bore-to-edge annulus.
 * `outline`/`boreOutline`/`margin` mirror manifold.ts's FlangeSpec exactly
 * (the wall's own outline, its bore, and the flange's margin beyond that
 * outline), so the mesh and STEP backends compute the identical layout from
 * identical inputs.
 */
export function layoutKeyholeMount(outline: ShapeOutline, boreOutline: ShapeOutline, margin: number): MountLayout {
  const halfTravel = SCREW_MOUNT_SLOT_TRAVEL / 2;
  const flangeOutline = offsetOutline(outline, margin);

  /** A slot centred on `axisDeg` (a `makeSlotAt` theta), or null if it doesn't fit there. Both channels stay PARALLEL to WALL_UP (see the file header): only the ANCHOR point rotates by `axisDeg`. */
  const slotAt = (axisDeg: number): KeyholeSlot | null => {
    const phi = standardAngleRad(axisDeg);
    const innerLimit = radiusAtAngle(boreOutline, phi) + SCREW_MOUNT_EDGE_MARGIN + SCREW_MOUNT_HEAD_RADIUS;
    const outerLimit = radiusAtAngle(flangeOutline, phi) - SCREW_MOUNT_EDGE_MARGIN - SCREW_MOUNT_SHANK_RADIUS;
    const bandLo = innerLimit + halfTravel;
    const bandHi = outerLimit - halfTravel;
    if (bandHi < bandLo) return null;
    const R = (bandLo + bandHi) / 2;
    const a = (axisDeg * Math.PI) / 180;
    const x = R * Math.sin(a);
    const y = R * Math.cos(a);
    return { head: { x, y: y - halfTravel }, shankEnd: { x, y: y + halfTravel } };
  };

  const flangeDiameter = 2 * inscribedRadius(outline, margin);
  const wantsTwoSlots = flangeDiameter >= SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD;

  if (wantsTwoSlots) {
    const axis = bestAxisDeg(boreOutline, SCREW_MOUNT_TWO_SLOT_ANGLE);
    const left = slotAt(axis - SCREW_MOUNT_TWO_SLOT_ANGLE);
    const right = slotAt(axis + SCREW_MOUNT_TWO_SLOT_ANGLE);
    if (left && right) return { slots: [left, right], recessDepth: SCREW_MOUNT_RECESS_DEPTH };
    // Fall through to the single-slot layout below rather than ever emit
    // invalid (or asymmetric, one-sided) geometry.
  }

  const singleAxis = bestAxisDeg(boreOutline, 0);
  const single = slotAt(singleAxis);
  if (single) return { slots: [single], recessDepth: SCREW_MOUNT_RECESS_DEPTH };

  return {
    slots: [],
    recessDepth: SCREW_MOUNT_RECESS_DEPTH,
    warning: "The flange is too narrow to fit the screw-keyhole mount (increase the core size, or the mount was skipped).",
  };
}
