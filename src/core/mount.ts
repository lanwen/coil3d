// Screw-keyhole wall mount (issue #13, docs/mounts.md, Screw mounts: the axis
// points out of the wall, and mount features sit on the bottom flange's
// outer face). Pure geometry math only -- no
// manifold-3d, no replicad -- so it is shared, unchanged, by BOTH backends
// (manifold.ts's mesh cut and step/build.ts's STEP cut), the same "two
// backends, one feature description" principle as wall.ts's WallProfile:
// the two must never place or size the slot(s) differently.
//
// Shape (in-plane, XY): a wide circle (screw-HEAD clearance) joined by a
// straight channel to a second, narrower circle (where the shank rests once
// hung) -- the classic hardware-store "keyhole slot", not a smoothly tapered
// capsule: real keyhole hangers step down abruptly from the head opening to
// a narrower rail, which is also simpler to build identically in manifold-3d
// (2 cylinders + an extruded rectangle) and replicad (2 circles + a drawn
// rectangle, unioned in 2D then extruded once).
//
// Depth (issue #71, "verify the keyhole actually catches the screw"): the
// SAME two-circles-plus-channel shape above is cut TWICE, at two different
// depths from the flange's outer face (see constants.ts's
// SCREW_MOUNT_SLOT_DEPTH/SCREW_MOUNT_UNDERCUT_DEPTH and manifold.ts's/
// step/build.ts's `screwMountCutter`/`screwMountCutterSolid`): a shallow
// level right at the surface, where the channel and shank-rest circle are
// NARROW (SCREW_MOUNT_SLOT_RADIUS -- wider than the shank, narrower than the
// head), and a deeper "undercut" level directly behind it, where they widen
// to the full head radius. The shallow level is what a real keyhole hanger's
// user actually SEES (a narrow slot); the deeper, wider level behind it is
// what actually lets the HEAD travel from the head-entry hole to the
// shank's resting point and then stay captured there once seated -- an
// earlier, single-depth version of this cut looked right but was
// mechanically impossible to assemble (its channel was only shank-width at
// every depth, so an 8mm head could never actually reach the 4mm-wide
// resting position at all).
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
// Rotation (issue #71, `keyholeRotation`/`KEYHOLE_ROTATION_OPTIONS`): the
// user can ask `bestAxisDeg` to prefer a DIFFERENT one of the shape's own
// natural mirror axes (see `candidateAxisDegs`) than whichever needs the
// least flange margin -- 0 (the default) or 45 degrees off literal
// vertical. The search window itself (`SCREW_MOUNT_AXIS_SEARCH_MAX_DEG`,
// 60 degrees) is NEVER shifted by this request, only used as the SET the
// request picks from -- so the result always hangs level AND always
// retains the coil (see `KEYHOLE_ROTATION_OPTIONS`'s own doc comment for
// why a literal 90-degree option is unsafe and not offered: a channel that
// far off vertical, once actually hung level, would be horizontal, with
// zero gravity component along its own length).
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
  DEFAULT_THROUGH_HOLE_DIAMETER,
  SCREW_MOUNT_ANNULUS_WIDTH,
  SCREW_MOUNT_AXIS_SEARCH_MAX_DEG,
  SCREW_MOUNT_EDGE_MARGIN,
  SCREW_MOUNT_HEAD_RADIUS,
  SCREW_MOUNT_RECESS_DEPTH,
  SCREW_MOUNT_SLOT_TRAVEL,
  SCREW_MOUNT_TWO_SLOT_ANGLE,
  SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD,
  THROUGH_MOUNT_EDGE_MARGIN,
  THROUGH_MOUNT_ENVELOPE_MARGIN,
  THROUGH_MOUNT_PAD_CLEARANCE,
  THROUGH_MOUNT_ROUND_HOLE_COUNTS,
} from "./constants";
import type { XY } from "./innerEnd";
import { circumscribedRadius, inscribedRadius, offsetOutline, radiusAtAngle } from "./shapes";
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

/**
 * `makeSlotAt`'s theta (degrees from WALL_UP) <-> shapes.ts's standard angle
 * (radians from +X). Exported so mountPlate.ts (issue #14) can place the
 * clip mount plate's own columns/rows on the SAME WALL_UP-relative axis
 * convention as the screw-keyhole slots, without redefining it.
 */
export function standardAngleRad(thetaDeg: number): number {
  return ((90 - thetaDeg) * Math.PI) / 180;
}

/**
 * Every corner's and every side-midpoint's own standard angle, converted to
 * `makeSlotAt` theta and normalised to (-180, 180], keeping only those within
 * `SCREW_MOUNT_AXIS_SEARCH_MAX_DEG` of TRUE vertical (theta=0, `WALL_UP`) --
 * see the file header. This window is FIXED -- issue #71 PR review: an
 * earlier version re-centred it on the rotation request instead, which let
 * the chosen axis drift arbitrarily far from true vertical (e.g. all the way
 * to 105 degrees off it for a 45-degree request) -- defeating the ENTIRE
 * point of this bound (this project's own accepted "how far off vertical can
 * the mount tilt and still reliably hang" limit, cos(60 deg)=0.5 of gravity's
 * pull retained at the very edge of it). `keyholeRotation` (see
 * `bestAxisDeg`) only ever chooses AMONG these same safe candidates, never
 * moves the window itself. Each candidate is (one end of) a genuine mirror
 * axis of the whole outline, so placing a slot on it, or two slots symmetric
 * about it, always hangs level.
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
 * Among the reachable axes (`candidateAxisDegs`, ALWAYS within
 * `SCREW_MOUNT_AXIS_SEARCH_MAX_DEG` of true vertical -- never shifted, see
 * that function's own doc comment), which one to use:
 *
 * - `keyholeRotation === 0` (the default, issue #13's original behaviour,
 *   unchanged): whichever axis needs the LEAST flange margin (the smallest
 *   `radiusAtAngle` at its own FANNED position, `axis + fanDeg` -- pass
 *   `fanDeg=0` for the single-slot case), tie-broken by closeness to true
 *   vertical. A side's own midpoint has NO bulge at all (`radiusAtAngle`
 *   there is just `apothem`, the same as round); a corner's own midpoint has
 *   the FULL bulge (`circumscribedRadius`) -- always the more expensive
 *   choice, so this never picks a corner when a side is reachable.
 * - `keyholeRotation !== 0` (issue #71, `KEYHOLE_ROTATION_OPTIONS`): the
 *   user has explicitly asked for a DIFFERENT axis than the automatic
 *   (cheapest) one -- so this instead picks whichever SAFE candidate sits
 *   CLOSEST to that request, cost only as a final tie-break (design.ts's
 *   `requiredFlangeMargin` already grows the flange margin to fit whichever
 *   axis is actually chosen, exactly as it already does for the automatic
 *   case, so a more expensive explicit choice is never silently rejected,
 *   only costed) -- EXCLUDING the automatic axis itself whenever a second
 *   safe candidate is reachable at all (issue #120): a triangle only ever
 *   has 2 reachable candidates (its own corner and side axes, `+-30`
 *   degrees off vertical -- see `candidateAxisDegs`'s own doc comment), and
 *   the one closest to literal 45 is ALWAYS the same one the automatic
 *   (cheapest) pick already lands on for every triangle (its cheap side
 *   axis is simultaneously the closer of the two to 45) -- so picking
 *   purely by distance-to-request, with no regard for what the automatic
 *   case already chose, made `keyholeRotation=45` a silent no-op for every
 *   triangle (confirmed bug: rotating 0 -> 45 produced byte-identical slot
 *   positions). A shape with only one reachable candidate at all (rare, but
 *   not provably impossible for extreme n) still has no OTHER axis to move
 *   to, so this falls back to that same one rather than refusing to place
 *   the mount at all.
 */
export function bestAxisDeg(boreOutline: ShapeOutline, fanDeg: number, keyholeRotation = 0): number {
  const candidates = candidateAxisDegs(boreOutline.n);

  /** Whichever candidate in `pool` needs the LEAST flange margin (`radiusAtAngle` at its own fanned position), tie-broken by closeness to true vertical -- the automatic (kr=0) rule, factored out so the `keyholeRotation !== 0` branch can also use it to find (and then exclude) the automatic pick. */
  const cheapestOf = (pool: number[]): number => {
    let best = pool[0] ?? 0;
    let bestRadius = Infinity;
    for (const theta of pool) {
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
  };

  if (keyholeRotation === 0) return cheapestOf(candidates);

  const autoAxis = cheapestOf(candidates);
  const others = candidates.filter((theta) => Math.abs(theta - autoAxis) > 1e-6);
  const pool = others.length > 0 ? others : candidates;

  let best = pool[0] ?? autoAxis;
  let bestDist = Infinity;
  let bestRadius = Infinity;
  for (const theta of pool) {
    const dist = Math.abs(theta - keyholeRotation);
    const r = radiusAtAngle(boreOutline, standardAngleRad(theta + fanDeg));
    const tiedDist = Math.abs(dist - bestDist) < 1e-6;
    if (dist < bestDist - 1e-6 || (tiedDist && r < bestRadius - 1e-6)) {
      bestDist = dist;
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
 *
 * `keyholeRotation` (issue #71) must match whatever `layoutKeyholeMount` is
 * about to be called with: a rotated axis can need a different margin to
 * fit (design.ts calls this BEFORE the flange margin -- and so the layout
 * itself -- is resolved, exactly like the unrotated case already did).
 */
export function requiredFlangeMargin(outline: ShapeOutline, boreOutline: ShapeOutline, keyholeRotation = 0): number {
  const requiredAnnulusAt = (fanDeg: number): number => {
    const axis = bestAxisDeg(boreOutline, fanDeg, keyholeRotation);
    const phi = standardAngleRad(axis + fanDeg);
    // The wall's own outer (winding) surface, NOT the bore -- must match
    // `slotAt`'s own `innerLimit` reference exactly, or this could solve for
    // a margin that "fits" by the wrong measure (see that function's own
    // doc comment on why the bore alone isn't the right inner bound).
    const wallR = radiusAtAngle(outline, phi);
    // A hairline (1e-6 mm) safety margin past the bare-minimum target: this
    // margin is found by bisection, not a closed form (see this function's
    // own doc comment), so its own `hi` can land close enough to the true
    // boundary that `layoutKeyholeMount`'s later, independent recomputation
    // of the SAME "does it fit" check (`slotAt`'s `outerLimit - innerLimit`)
    // occasionally reads a few ULPs short of the target it was solved
    // against -- imperceptible at print scale, but enough to flip a `>=`
    // into a `<` and report "doesn't fit" for a margin that, by construction,
    // was meant to.
    const target = wallR + SCREW_MOUNT_ANNULUS_WIDTH + 1e-6;

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
  /**
   * The `bestAxisDeg` theta this layout's slot(s) are actually centred/
   * mirrored on (undefined when `slots` is empty). Not always 0: per the
   * file header, a shape without a genuine mirror axis at literal vertical
   * (a triangle, at this construction's fixed corner angles) still hangs
   * level, just with THIS axis vertical instead of local +Y -- so a
   * consumer that wants to actually SHOW the real hung orientation (rather
   * than the design's own unrotated local frame) needs this value to
   * correct for the difference (CoilViewer.tsx's wall presets do exactly
   * that).
   */
  axisDeg?: number;
}

/**
 * Lay out 1-2 keyhole slots in the flange's bore-to-edge annulus.
 * `outline`/`boreOutline`/`margin` mirror manifold.ts's FlangeSpec exactly
 * (the wall's own outline, its bore, and the flange's margin beyond that
 * outline), so the mesh and STEP backends compute the identical layout from
 * identical inputs.
 *
 * `keyholeRotation` (issue #71, one of `KEYHOLE_ROTATION_OPTIONS`) asks
 * `bestAxisDeg` to prefer a different one of the shape's own natural axes --
 * see that function's own doc comment. Default 0 reproduces the original,
 * pre-#71 placement exactly.
 */
export function layoutKeyholeMount(outline: ShapeOutline, boreOutline: ShapeOutline, margin: number, keyholeRotation = 0): MountLayout {
  const halfTravel = SCREW_MOUNT_SLOT_TRAVEL / 2;
  const flangeOutline = offsetOutline(outline, margin);

  /**
   * A slot centred on `axisDeg` (a `makeSlotAt` theta), or null if it
   * doesn't fit there. Both channels stay PARALLEL to WALL_UP (see the file
   * header): only the ANCHOR point rotates by `axisDeg`.
   *
   * `innerLimit` clears the WALL'S OWN outer (winding) surface (`outline`
   * at offset 0), NOT the hollow bore (issue #71 PR review, a confirmed
   * bug): the flange's own inner annulus, from the bore out to `outline`,
   * sits DIRECTLY BELOW the solid wall tube (same footprint, welded
   * together at z=0) -- it is NOT empty/hollow space the way the bore
   * itself is. A cut placed there would undermine the wall's own printed
   * support (the wall exists at z>=0 with nothing but this same flange
   * material underneath it at z<0) even though it never touches the bore.
   * The safe region for any mount cut is only the OUTER annulus, `outline`
   * to the flange's own true edge.
   *
   * `outerLimit` budgets `SCREW_MOUNT_HEAD_RADIUS` at the shank-rest end too
   * (issue #71), not just at the head end: that end's own SURFACE opening is
   * narrower (`SCREW_MOUNT_SLOT_RADIUS`), but the undercut chamber directly
   * behind it (same XY position, see `SCREW_MOUNT_UNDERCUT_DEPTH`) is
   * head-width, so the cut's true widest reach at EITHER end, across its
   * full depth, is the head radius -- the flange must clear THAT, not just
   * the narrower surface opening, or the undercut breaks through the edge.
   */
  const slotAt = (axisDeg: number): KeyholeSlot | null => {
    const phi = standardAngleRad(axisDeg);
    const innerLimit = radiusAtAngle(outline, phi) + SCREW_MOUNT_EDGE_MARGIN + SCREW_MOUNT_HEAD_RADIUS;
    const outerLimit = radiusAtAngle(flangeOutline, phi) - SCREW_MOUNT_EDGE_MARGIN - SCREW_MOUNT_HEAD_RADIUS;
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
    const axis = bestAxisDeg(boreOutline, SCREW_MOUNT_TWO_SLOT_ANGLE, keyholeRotation);
    const left = slotAt(axis - SCREW_MOUNT_TWO_SLOT_ANGLE);
    const right = slotAt(axis + SCREW_MOUNT_TWO_SLOT_ANGLE);
    if (left && right) return { slots: [left, right], recessDepth: SCREW_MOUNT_RECESS_DEPTH, axisDeg: axis };
    // Fall through to the single-slot layout below rather than ever emit
    // invalid (or asymmetric, one-sided) geometry.
  }

  const singleAxis = bestAxisDeg(boreOutline, 0, keyholeRotation);
  const single = slotAt(singleAxis);
  if (single) return { slots: [single], recessDepth: SCREW_MOUNT_RECESS_DEPTH, axisDeg: singleAxis };

  return {
    slots: [],
    recessDepth: SCREW_MOUNT_RECESS_DEPTH,
    warning: "The flange is too narrow to fit the screw-keyhole mount (increase the core size, or the mount was skipped).",
  };
}

// --- Through-hole wall mount (issue #70, docs/mounts.md, Screw mounts) -----
//
// Plain, constant-radius screw-shank holes cut straight through the bottom
// flange -- a permanent, non-sliding alternative to the screw-keyhole mount
// above. Unlike the keyhole mount, there's no "hang it, then slide to seat"
// mechanics and so no gravity-driven "up" direction to search for: every
// hole sits at a FIXED angle -- a corner's own centre for sq/tri (the
// widest part of the margin annulus, shapes.ts's own corner-bulge
// construction), or evenly spaced for round -- never searched or rotated.
//
// Issue #129: the hole has no counterbore and no pad -- just a straight
// cylinder, the same radius through the flange's full depth, with the
// flange staying its ordinary plate thickness right up to the hole's own
// edge (flange.ts, flangePads.ts). The screw head bears directly on the
// flange's winding-side face.
//
// Because every candidate angle here is exactly where `radiusAtAngle` is
// additive in offset (round: `radiusAtAngle` is constant, any angle; sq/tri:
// a corner's own centre, where shapes.ts's `radiusAtAngle` reduces to
// `circumscribedRadius` -- see that function's own doc comment), the
// required-margin calculation below is a closed form, unlike the keyhole
// mount's own bisection-based `requiredFlangeMargin`.

export interface ThroughHole {
  /** Hole centre, in the flange's local XY (mm). */
  x: number;
  y: number;
}

export interface ThroughMountLayout {
  holes: ThroughHole[];
  /** Through-hole (screw-shank clearance) radius, mm -- half of the user's own `throughHoleDiameter`, constant through the flange's full depth (issue #129: no counterbore). */
  holeRadius: number;
  /** Set when one or more corners (sq/tri) were skipped, or the mount didn't fit at all (empty `holes`). */
  warning?: string;
}

/**
 * The minimum flange margin that lets `layoutThroughHoleMount` place every
 * hole (mirrors mount.ts's own `requiredFlangeMargin`, but as a closed form
 * -- see the file header above). `envelopeRadius` (issue #70 AC: holes must
 * be reachable with a screwdriver, "outside the winding envelope") is the
 * wound cable's own outer radius (`Solution.envelopeDiameter / 2`, 0 if not
 * yet known/relevant) -- when it reaches further out than the wall's own
 * surface does, it becomes the REAL inner bound instead.
 */
export function requiredThroughMountMargin(
  outline: ShapeOutline,
  _boreOutline: ShapeOutline,
  holeDiameter: number = DEFAULT_THROUGH_HOLE_DIAMETER,
  envelopeRadius = 0,
): number {
  const holeRadius = holeDiameter / 2;
  const isRound = outline.cornerRadius === outline.apothem;
  const outlineR0 = isRound ? outline.apothem : circumscribedRadius(outline, 0);
  // The wall's own outer (winding) surface -- NOT the bore (issue #71 PR
  // review's same fix, mirrored here: see `layoutKeyholeMount`'s `slotAt`
  // doc comment for why the bore alone isn't the right inner bound) -- or
  // the wound envelope, whichever reaches further out.
  const innerBound0 = Math.max(outlineR0 + THROUGH_MOUNT_EDGE_MARGIN, envelopeRadius + THROUGH_MOUNT_ENVELOPE_MARGIN);
  // A hairline (1e-6 mm) safety margin past the bare-minimum requirement --
  // mirrors `requiredFlangeMargin`'s own epsilon: without it, floating-point
  // rounding can occasionally leave `layoutThroughHoleMount`'s later,
  // independent recomputation of this SAME "does it fit" check a few ULPs
  // short of the target it was solved against.
  const target = innerBound0 + 2 * holeRadius + THROUGH_MOUNT_EDGE_MARGIN + 1e-6;
  const required = target - outlineR0;
  return Math.max(0, required);
}

/** Point-to-closed-polygon minimum distance (mm) -- used to keep a through-hole clear of the inner-end cable channel's own cut footprint (issue #70 AC: "clear of ... the inner-end channel"). */
export function distanceToClosedPolygon(px: number, py: number, points: XY[]): number {
  let best = Infinity;
  let inside = false;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    // Issue #115: inside the polygon counts as distance 0 (see mountPlate.ts's `distanceToPolygon`).
    if (a.y > py !== b.y > py && px < a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}

/**
 * Lay out through-holes in the flange's bore-to-edge annulus (issue #70):
 * one per corner for sq/tri (in the flange's own corner areas -- AC), or
 * evenly spaced (issue #70 AC: "3 or 4") for round, widest count first. Every
 * candidate is also checked against the inner-end cable channel's own real,
 * computed footprint (`keepOut.channelRibbon`, innerEnd.ts's `layoutInnerEnd`
 * -- AC: "clear of ... the inner-end channel") and, issue #139, against every
 * flange pad's footprint on the plate (`keepOut.pads`, flangePads.ts's
 * `layoutFlangeThroughHoles`): the screw head bears on the plate's top
 * (issue #129), so the head -- the hole plus its THROUGH_MOUNT_EDGE_MARGIN
 * bearing ring -- keeps THROUGH_MOUNT_PAD_CLEARANCE of plain plate between
 * it and the channel pad's chamfers, fillet and tail, and the collar. Never
 * just assumed clear:
 * round rotates the ring if the plain one collides (round has full
 * rotational freedom, unlike sq/tri's fixed corners), and sq/tri
 * simply skips (and warns about) whichever corner doesn't clear, keeping
 * every other corner's hole rather than giving up the whole mount over one
 * conflict.
 *
 * `envelopeRadius` (issue #70 AC, PR review: holes must be reachable with a
 * screwdriver, "outside the winding envelope") is the wound cable's own
 * outer radius (`Solution.envelopeDiameter / 2`) -- every hole is also kept
 * at least `THROUGH_MOUNT_ENVELOPE_MARGIN` beyond it, not just beyond the
 * wall's own surface (`_boreOutline` is unused here for the SAME reason
 * `layoutKeyholeMount`'s `slotAt` no longer uses it: the flange's own inner
 * annulus, bore to `outline`, sits directly below the solid wall and is
 * NOT a safe place to cut, regardless of the hollow bore).
 */
export function layoutThroughHoleMount(
  outline: ShapeOutline,
  _boreOutline: ShapeOutline,
  margin: number,
  holeDiameter: number = DEFAULT_THROUGH_HOLE_DIAMETER,
  keepOut: { channelRibbon: XY[]; pads?: XY[][] },
  envelopeRadius = 0,
): ThroughMountLayout {
  const holeRadius = holeDiameter / 2;
  const flangeOutline = offsetOutline(outline, margin);
  const isRound = outline.cornerRadius === outline.apothem;
  const base = { holeRadius };
  const tooNarrowWarning = "The flange is too narrow (or too close to the inner-end cable channel) to fit the through-hole mount (increase the core size, or the mount was skipped).";

  const clearOfChannel = (x: number, y: number): boolean => {
    const headRadius = holeRadius + THROUGH_MOUNT_EDGE_MARGIN;
    const clearOfRibbon = keepOut.channelRibbon.length < 3 || distanceToClosedPolygon(x, y, keepOut.channelRibbon) >= headRadius;
    return clearOfRibbon && (keepOut.pads ?? []).every((pad) => distanceToClosedPolygon(x, y, pad) >= headRadius + THROUGH_MOUNT_PAD_CLEARANCE);
  };

  /** A hole centred on standard angle `phi` (shapes.ts convention), or null if it doesn't fit there. */
  const holeAt = (phi: number): ThroughHole | null => {
    const wallBound = radiusAtAngle(outline, phi) + THROUGH_MOUNT_EDGE_MARGIN;
    const envelopeBound = envelopeRadius + THROUGH_MOUNT_ENVELOPE_MARGIN;
    const innerLimit = Math.max(wallBound, envelopeBound) + holeRadius;
    const outerLimit = radiusAtAngle(flangeOutline, phi) - THROUGH_MOUNT_EDGE_MARGIN - holeRadius;
    if (outerLimit < innerLimit) return null;
    const R = (innerLimit + outerLimit) / 2;
    return { x: R * Math.cos(phi), y: R * Math.sin(phi) };
  };

  if (isRound) {
    for (const count of THROUGH_MOUNT_ROUND_HOLE_COUNTS) {
      /** The ring of `count` holes rotated by `offsetDeg`, or null if any of them doesn't fit or clear. */
      const ringAt = (offsetDeg: number): ThroughHole[] | null => {
        const holes: ThroughHole[] = [];
        for (let i = 0; i < count; i++) {
          const h = holeAt((2 * Math.PI * i) / count + (offsetDeg * Math.PI) / 180);
          if (!h || !clearOfChannel(h.x, h.y)) return null;
          holes.push(h);
        }
        return holes;
      };
      const plain = ringAt(0);
      if (plain) return { ...base, holes: plain };
      // Issue #139: rotate the ring (in whole degrees) to the middle of the
      // widest range of rotations that clears, so the holes either side of
      // the channel pad keep about the same room.
      let best: { from: number; to: number } | undefined;
      let run: { from: number; to: number } | undefined;
      for (let o = 1; o < 360 / count; o++) {
        run = ringAt(o) ? { from: run?.from ?? o, to: o } : undefined;
        if (run && (!best || run.to - run.from > best.to - best.from)) best = run;
      }
      const rotated = best && ringAt(Math.round((best.from + best.to) / 2));
      if (rotated) return { ...base, holes: rotated };
    }
    return { ...base, holes: [], warning: tooNarrowWarning };
  }

  // sq/tri: one hole per corner (shapes.ts's own corner i at standard angle
  // 2*pi*i/n), skipping -- with a warning, never nudged elsewhere -- any
  // corner too close to the inner-end channel.
  const holes: ThroughHole[] = [];
  let skipped = 0;
  for (let i = 0; i < outline.n; i++) {
    const phi = (2 * Math.PI * i) / outline.n;
    const h = holeAt(phi);
    if (h && clearOfChannel(h.x, h.y)) holes.push(h);
    else skipped++;
  }
  if (holes.length === 0) return { ...base, holes: [], warning: tooNarrowWarning };
  return { ...base, holes, warning: skipped > 0 ? `${skipped} through-hole(s) skipped near a corner too close to the inner-end cable channel.` : undefined };
}
