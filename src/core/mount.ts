// Screw-keyhole wall mount (issue #13, docs/research.md "Mounting": "screw
// keyhole (wall)", "the axis points out of the wall; mount features sit on
// the bottom flange's outer face"). Pure geometry math only -- no
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
// user can shift `bestAxisDeg`'s own search away from literal vertical by a
// fixed 0/45/90 degree step, landing the slot(s) on a DIFFERENT one of the
// shape's own natural mirror axes (see `candidateAxisDegs`) instead of
// whichever needs the least flange margin. The result still always hangs
// level -- rotation only changes WHICH natural axis is chosen, never
// invents a non-symmetric one -- so "the mount axis and the hanging stay
// level" holds for every option.
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
  THROUGH_MOUNT_COUNTERBORE_DEPTH,
  THROUGH_MOUNT_COUNTERBORE_MARGIN,
  THROUGH_MOUNT_EDGE_MARGIN,
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
 * `SCREW_MOUNT_AXIS_SEARCH_MAX_DEG` of `referenceDeg` (default 0, i.e.
 * literal vertical/`WALL_UP`) -- see the file header. Each one is (one end
 * of) a genuine mirror axis of the whole outline, so placing a slot on it, or
 * two slots symmetric about it, always hangs level, whatever `referenceDeg`
 * is: it only shifts WHICH of the shape's own natural axes the search
 * considers, never invents a non-symmetric one (issue #71's `keyholeRotation`
 * -- see `bestAxisDeg`).
 */
function candidateAxisDegs(n: number, referenceDeg = 0): number[] {
  const stepDeg = 360 / n;
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const standardDeg of [i * stepDeg, i * stepDeg + stepDeg / 2]) {
      const theta = (((90 - standardDeg + 180) % 360) + 360) % 360 - 180;
      const distFromReference = (((theta - referenceDeg + 180) % 360) + 360) % 360 - 180;
      if (Math.abs(distFromReference) <= SCREW_MOUNT_AXIS_SEARCH_MAX_DEG) candidates.push(theta);
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
 *
 * `referenceDeg` (issue #71, `KEYHOLE_ROTATION_OPTIONS`) re-centres BOTH the
 * search window (`candidateAxisDegs`) and the near-tie break below on this
 * angle instead of literal vertical -- e.g. for a square (whose natural axes
 * sit every 45 degrees, corner and flat-side-midpoint alternating),
 * `referenceDeg=45` lands the search on the OTHER kind of axis than
 * `referenceDeg=0` would, without ever picking a non-symmetric angle: the
 * result still always hangs level (see `candidateAxisDegs`'s own doc
 * comment), just with a different corner/side of the core facing up.
 */
export function bestAxisDeg(boreOutline: ShapeOutline, fanDeg: number, referenceDeg = 0): number {
  let best = referenceDeg;
  let bestRadius = Infinity;
  for (const theta of candidateAxisDegs(boreOutline.n, referenceDeg)) {
    const r = radiusAtAngle(boreOutline, standardAngleRad(theta + fanDeg));
    // Prefer a strictly cheaper candidate, but break a (near-)tie -- e.g.
    // round, or any shape with no bulge to speak of, ties on EVERY
    // candidate -- by whichever sits closest to `referenceDeg`, so a
    // fully-agnostic shape still gets the visually obvious "reference centre"
    // placement instead of an arbitrary, equally-valid-but-surprising tilt.
    const tied = Math.abs(r - bestRadius) < 1e-6;
    if (r < bestRadius - 1e-6 || (tied && Math.abs(theta - referenceDeg) < Math.abs(best - referenceDeg))) {
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
    const boreR = radiusAtAngle(boreOutline, phi);
    // A hairline (1e-6 mm) safety margin past the bare-minimum target: this
    // margin is found by bisection, not a closed form (see this function's
    // own doc comment), so its own `hi` can land close enough to the true
    // boundary that `layoutKeyholeMount`'s later, independent recomputation
    // of the SAME "does it fit" check (`slotAt`'s `outerLimit - innerLimit`)
    // occasionally reads a few ULPs short of the target it was solved
    // against -- imperceptible at print scale, but enough to flip a `>=`
    // into a `<` and report "doesn't fit" for a margin that, by construction,
    // was meant to.
    const target = boreR + SCREW_MOUNT_ANNULUS_WIDTH + 1e-6;

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
 * `keyholeRotation` (issue #71, one of `KEYHOLE_ROTATION_OPTIONS`) shifts
 * `bestAxisDeg`'s own search reference away from literal vertical -- see
 * that function's doc comment. Default 0 reproduces the original,
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
    const innerLimit = radiusAtAngle(boreOutline, phi) + SCREW_MOUNT_EDGE_MARGIN + SCREW_MOUNT_HEAD_RADIUS;
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

// --- Through-hole wall mount (issue #70, docs/research.md "Mounting") -----
//
// Plain, counterbored screw-shank holes cut straight through the bottom
// flange -- a permanent, non-sliding alternative to the screw-keyhole mount
// above. Unlike the keyhole mount, there's no "hang it, then slide to seat"
// mechanics and so no gravity-driven "up" direction to search for: every
// hole sits at a FIXED angle -- a corner's own centre for sq/tri (the
// widest part of the margin annulus, shapes.ts's own corner-bulge
// construction), or evenly spaced for round -- never searched or rotated.
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
  /** Depth of the counterbore, cut inward from the flange's outer (wall-facing) face, mm. */
  counterboreDepth: number;
  /** Counterbore (screw-head clearance) radius, mm. */
  counterboreRadius: number;
  /** Through-hole (screw-shank clearance) radius, mm -- half of the user's own `throughHoleDiameter`. */
  holeRadius: number;
  /** Set when one or more corners (sq/tri) were skipped, or the mount didn't fit at all (empty `holes`). */
  warning?: string;
}

/**
 * The minimum flange margin that lets `layoutThroughHoleMount` place every
 * hole (mirrors mount.ts's own `requiredFlangeMargin`, but as a closed form
 * -- see the file header above).
 */
export function requiredThroughMountMargin(outline: ShapeOutline, boreOutline: ShapeOutline, holeDiameter: number = DEFAULT_THROUGH_HOLE_DIAMETER): number {
  const counterboreRadius = holeDiameter / 2 + THROUGH_MOUNT_COUNTERBORE_MARGIN;
  const isRound = outline.cornerRadius === outline.apothem;
  const outlineR0 = isRound ? outline.apothem : circumscribedRadius(outline, 0);
  const boreR = isRound ? boreOutline.apothem : circumscribedRadius(boreOutline, 0);
  // A hairline (1e-6 mm) safety margin past the bare-minimum requirement --
  // mirrors `requiredFlangeMargin`'s own epsilon: without it, `outlineR0`'s
  // own floating-point rounding can occasionally leave `layoutThroughHoleMount`'s
  // later, independent recomputation of this SAME "does it fit" check a few
  // ULPs short of the target it was solved against.
  const required = boreR + 2 * THROUGH_MOUNT_EDGE_MARGIN + 2 * counterboreRadius - outlineR0 + 1e-6;
  return Math.max(0, required);
}

/** Point-to-closed-polygon minimum distance (mm) -- used to keep a through-hole clear of the inner-end cable channel's own cut footprint (issue #70 AC: "clear of ... the inner-end channel"). */
function distanceToClosedPolygon(px: number, py: number, points: XY[]): number {
  let best = Infinity;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Lay out through-holes in the flange's bore-to-edge annulus (issue #70):
 * one per corner for sq/tri (in the flange's own corner areas -- AC), or
 * evenly spaced (issue #70 AC: "3 or 4") for round, widest count first. Every
 * candidate is also checked against the inner-end cable channel's own real,
 * computed footprint (`innerEndChannel`, innerEnd.ts's `layoutInnerEnd` --
 * AC: "clear of ... the inner-end channel") -- never just assumed clear:
 * round retries a half-step-rotated ring if the plain one collides (round
 * has full rotational freedom, unlike sq/tri's fixed corners), and sq/tri
 * simply skips (and warns about) whichever corner doesn't clear, keeping
 * every other corner's hole rather than giving up the whole mount over one
 * conflict.
 */
export function layoutThroughHoleMount(
  outline: ShapeOutline,
  boreOutline: ShapeOutline,
  margin: number,
  holeDiameter: number = DEFAULT_THROUGH_HOLE_DIAMETER,
  innerEndChannel: { hole: XY; holeRadius: number; channelRibbon: XY[] },
): ThroughMountLayout {
  const holeRadius = holeDiameter / 2;
  const counterboreRadius = holeRadius + THROUGH_MOUNT_COUNTERBORE_MARGIN;
  const flangeOutline = offsetOutline(outline, margin);
  const isRound = outline.cornerRadius === outline.apothem;
  const base = { counterboreDepth: THROUGH_MOUNT_COUNTERBORE_DEPTH, counterboreRadius, holeRadius };
  const tooNarrowWarning = "The flange is too narrow (or too close to the inner-end cable channel) to fit the through-hole mount (increase the core size, or the mount was skipped).";

  const clearOfChannel = (x: number, y: number): boolean => {
    const requiredClearance = counterboreRadius + THROUGH_MOUNT_EDGE_MARGIN;
    if (Math.hypot(x - innerEndChannel.hole.x, y - innerEndChannel.hole.y) < requiredClearance + innerEndChannel.holeRadius) return false;
    return innerEndChannel.channelRibbon.length < 3 || distanceToClosedPolygon(x, y, innerEndChannel.channelRibbon) >= requiredClearance;
  };

  /** A hole centred on standard angle `phi` (shapes.ts convention), or null if it doesn't fit there. */
  const holeAt = (phi: number): ThroughHole | null => {
    const innerLimit = radiusAtAngle(boreOutline, phi) + THROUGH_MOUNT_EDGE_MARGIN + counterboreRadius;
    const outerLimit = radiusAtAngle(flangeOutline, phi) - THROUGH_MOUNT_EDGE_MARGIN - counterboreRadius;
    if (outerLimit < innerLimit) return null;
    const R = (innerLimit + outerLimit) / 2;
    return { x: R * Math.cos(phi), y: R * Math.sin(phi) };
  };

  if (isRound) {
    for (const count of THROUGH_MOUNT_ROUND_HOLE_COUNTS) {
      for (const offsetDeg of [0, 180 / count]) {
        const holes: ThroughHole[] = [];
        let ok = true;
        for (let i = 0; i < count && ok; i++) {
          const phi = (2 * Math.PI * i) / count + (offsetDeg * Math.PI) / 180;
          const h = holeAt(phi);
          if (!h || !clearOfChannel(h.x, h.y)) {
            ok = false;
            break;
          }
          holes.push(h);
        }
        if (ok) return { ...base, holes };
      }
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
