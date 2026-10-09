// Shared joint-geometry numbers (issue #9, docs/design.md, Parts and printing and
// Tolerances): both the mesh backend (manifold.ts, via
// manifold-3d primitives) and the STEP backend (step/build.ts, via
// replicad/OCCT primitives) derive their joint dimensions from this ONE
// function, so the two backends can never drift apart on fit -- mirroring
// how wallSpec/flangeSpec keep the mesh and STEP walls from drifting.
//
// All three joints share the SAME engagement-radius arithmetic (fit gap +
// per-kind clearance) regardless of the core's own cross-section
// (round/sq/tri), but the collar's own OUTLINE follows the bore's true shape
// (issue #55), not a plain circle: `collarRadius`/`boreRadius` below are the
// FLAT-SIDE (apothem) values, used to size that outline consistently for
// every shape (round degenerates to its old plain-circle collar for free,
// see shapes.ts's own "round is n=4, cornerRadius=apothem" convention).
//
// Why this matters: a plain circular collar sized off the bore's inscribed
// (flat-side) radius clears a non-round bore's CORNERS by a large, uneven
// margin. Issue #55 hit this on the collar's old weld flare (a circle that
// never reached a non-round plate hole's corners, leaving a floating
// collar). Since #127 the plate is solid under the collar, so every collar
// now runs straight up WELD_OVERLAP into the plate (issue #172) and only the
// snap fingers keep a root flare (`snapLayout`'s `rootOutline`), which stays
// inside the core's relief.

import {
  BAYONET_GAP,
  BAYONET_LUG_COUNT,
  BAYONET_LUG_HEIGHT,
  BAYONET_LUG_MAX_DEG,
  BAYONET_LUG_TIP,
  BAYONET_LUG_WIDTH,
  BAYONET_LUG_DROP,
  BAYONET_MIN_LAND,
  BAYONET_MIN_WALL,
  CAP_COLLAR_WALL,
  CAP_THICKNESS,
  JOINT_ENGAGE_DEPTH,
  JOINT_FIT_GAP,
  JOINT_MIN_BORE_RADIUS,
  SNAP_BARB,
  SNAP_BARB_CLEARANCE,
  SNAP_COLLAR_WALL,
  SNAP_FINGER_LENGTH,
  SNAP_LEAD_IN_ANGLE,
  SNAP_PRELOAD,
  SNAP_RIDGE_DEPTH,
  SNAP_RIDGE_THICKNESS,
  SNAP_SEAT_GAP,
  SHAPE_ROUNDING_EPS,
  WELD_OVERLAP,
} from "./constants";
import { circumscribedRadius, inscribedRadius, offsetOutline } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { JointKind, ShapeKind } from "./types";
import type { WallSpec } from "./wall";

export type JointWall = Pick<WallSpec, "boreOutline" | "height" | "outline" | "grooveDepth">;

export interface JointGeometry {
  /** The bore's own inscribed (flat-side) radius, mm -- the collar's absolute ceiling. */
  boreRadius: number;
  /** The engagement collar's nominal radius before the per-kind fit clearance: the bore's inscribed radius, minus a fixed gap so a non-round bore's corners are never touched. */
  jointRadius: number;
  /** The collar/finger OD actually used (its flat-side/apothem value), after `tolerance` and (for bayonet/snap) the extra sliding/flex clearance those joints need. */
  collarRadius: number;
  /**
   * The engagement collar's own footprint (issue #55): the bore's outline,
   * offset inward so its apothem equals `collarRadius` -- a uniform gap from
   * the bore's true wall at every angle (flat sides AND corners), not just a
   * circle inscribed at the flats. Round reduces to a plain circle of radius
   * `collarRadius` for free (see shapes.ts's `offsetOutline`). The corner
   * radius is floored a hairline above 0 (`SHAPE_ROUNDING_EPS`, matching
   * solve.ts's own "never quite fully round" floor), never left negative --
   * an inward offset larger than the bore's own corner radius would
   * otherwise invert the outline (shapes.ts's `offsetOutline` doc comment).
   */
  collarOutline: ShapeOutline;
  /**
   * Issue #127: the through-hole in the cap's middle -- `collarOutline`
   * offset inward by CAP_COLLAR_WALL, cut straight through the collar and
   * the plate, so the collar is a tube and nothing prints as a bridge over
   * a hollow. Undefined when the collar is too thin to be a tube (a hole
   * under 1 mm across the flats); the collar then stays a solid plug.
   */
  holeOutline?: ShapeOutline;
}

export function jointGeometry(boreOutline: ShapeOutline, kind: JointKind, tolerance: number): JointGeometry {
  const boreRadius = inscribedRadius(boreOutline, 0);
  const jointRadius = Math.max(2, boreRadius - JOINT_FIT_GAP);
  const collarRadius =
    kind === "press"
      ? Math.max(1, jointRadius - tolerance)
      : kind === "bayonet"
        ? Math.max(1, jointRadius - BAYONET_GAP - tolerance)
        : // Issue #186: the snap fingers sit in far enough that their barbs clear the bore, so no relief is cut into the core's wall.
          Math.max(1, boreRadius - SNAP_BARB_CLEARANCE - tolerance - SNAP_BARB);
  const collarOutline: ShapeOutline = {
    n: boreOutline.n,
    apothem: collarRadius,
    cornerRadius: Math.max(SHAPE_ROUNDING_EPS, boreOutline.cornerRadius - (boreRadius - collarRadius)),
  };
  // Issue #167: the bayonet's L-slots are cut into the collar, so its wall
  // grows to keep BAYONET_MIN_WALL behind them (see `bayonetLayout`).
  // Issue #186: the snap fingers are thinner, so they bend more easily and
  // leave a smaller step inside the seated cap.
  const collarWall =
    kind === "bayonet" ? BAYONET_LUG_HEIGHT + BAYONET_GAP + tolerance + BAYONET_MIN_WALL : kind === "snap" ? SNAP_COLLAR_WALL : CAP_COLLAR_WALL;
  const holeApothem = collarRadius - collarWall;
  const holeOutline: ShapeOutline | undefined =
    holeApothem >= 1
      ? { n: boreOutline.n, apothem: holeApothem, cornerRadius: Math.max(SHAPE_ROUNDING_EPS, collarOutline.cornerRadius - collarWall) }
      : undefined;
  return { boreRadius, jointRadius, collarRadius, collarOutline, holeOutline };
}

/**
 * One revolved feature of the bayonet (issue #167): `profile` -- a closed,
 * counter-clockwise polygon in the (radius, z) half-plane -- swept about the
 * Z axis from `startDeg` through `sweepDeg` (counter-clockwise seen from
 * above). Both backends build every lug, groove and slot this one way
 * (manifold-3d's `Manifold.revolve`, replicad's `Sketch.revolve`), so the
 * mesh and the STEP export can't drift apart.
 */
export interface RevolvedFeature {
  profile: [number, number][];
  startDeg: number;
  sweepDeg: number;
}

/**
 * The bayonet's geometry, shared by the mesh and STEP backends. Every z is
 * measured from the core's top rim (= the cap plate's underside), up
 * positive: the cap's local frame, and the core's frame shifted by its
 * height.
 */
export interface BayonetLayout {
  /** Lug centres on the core, degrees; the cap as drawn is locked onto them. */
  lugAnglesDeg: number[];
  /** How far the cap turns, clockwise seen from above, from entry to lock. At entry it sits `twistDeg` counter-clockwise of its drawn position. */
  twistDeg: number;
  /** Added to the core's bore, just under the rim. */
  lugs: RevolvedFeature[];
  /** Cut into the cap's collar: per lug, the entry slot up from the collar's tip (the L's upright) and the groove it turns along (the L's foot, ending in the stop). */
  cuts: RevolvedFeature[];
}

export type BayonetPlan = { layout: BayonetLayout; warning?: undefined } | { layout?: undefined; warning: string };

const deg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Issue #167: lay out the twist lock for one core, or say why it can't have
 * one -- the ONE place both backends (and design()'s warning) decide that,
 * so a fallback to the press-fit collar is always the same in the mesh and
 * the STEP export.
 *
 * The lugs stand IN the core's bore and the L-slots are cut into the cap's
 * collar, never the other way round: the core's wall carries the cable
 * groove, which runs up to about 2 mm under the rim, so a groove cut into
 * the wall there would leave too little of it. The collar is solid plastic
 * all the way round, and `jointGeometry` sizes its centre hole so
 * BAYONET_MIN_WALL always stays behind the groove.
 *
 * Profiles, in (r, z), with r_c the collar radius and g = BAYONET_GAP + tolerance:
 * - Lug: from 1 mm inside the bore wall in to r_c - BAYONET_LUG_HEIGHT,
 *   flat on top (BAYONET_LUG_DROP under the rim), a BAYONET_LUG_TIP
 *   vertical tip, then a 45 degree underside back out to the wall: the core
 *   prints upright, so no flat overhang.
 * - Groove: the lug grown by g (above it, inside its tip and square to its
 *   45 degree underside), so in the cap's print orientation (plate down)
 *   its ceiling is 45 degrees too.
 * - Slot: straight up from the collar's tip to the groove's top, the lug's
 *   width plus g each side, as deep as the groove.
 * Locked, the lugs sit at 0/120/240 degrees; at entry the cap is turned
 * `twistDeg` counter-clockwise, which puts its slots over them, and each
 * groove runs from its slot to just past its lug, where its end face is
 * the stop.
 */
export function bayonetLayout(shape: ShapeKind, wallSpec: JointWall, tolerance: number): BayonetPlan {
  if (shape !== "round") return { warning: "Twist lock needs a round core, so the top cap uses a press-fit collar." };
  const tooSmall = { warning: "This core is too small for the twist lock, so the top cap uses a press-fit collar." };

  const { boreOutline, height } = wallSpec;
  const rIn = inscribedRadius(boreOutline, 0);
  if (rIn < JOINT_MIN_BORE_RADIUS || height < JOINT_ENGAGE_DEPTH + 2) return tooSmall;
  const { collarRadius: rc } = jointGeometry(boreOutline, "bayonet", tolerance);

  const g = BAYONET_GAP + tolerance;
  const rTip = rc - BAYONET_LUG_HEIGHT;
  const rEmbed = rIn + WELD_OVERLAP;
  const rOut = rc + 1; // past the collar, so the cuts open cleanly out of it
  const zTop = -BAYONET_LUG_DROP;
  const zTip = zTop - BAYONET_LUG_TIP; // the bottom of the lug's vertical tip face
  // The lug's underside is z = zTip - (r - rTip); the groove's floor is that line moved out by g.
  const underside = (r: number, by: number) => zTip - (r - rTip) - by * Math.SQRT2;
  if (underside(rOut, g) < -JOINT_ENGAGE_DEPTH + 1) return tooSmall;

  const n = BAYONET_LUG_COUNT;
  const twistDeg = 180 / n;
  const lugWidthDeg = Math.min(deg(BAYONET_LUG_WIDTH / rc), BAYONET_LUG_MAX_DEG);
  const gapDeg = deg(g / (rTip - g));
  const slotWidthDeg = lugWidthDeg + 2 * gapDeg;
  // In the cap's frame, around each lug's locked angle: from the far side
  // of the entry slot to just past the lug, where the end face stops it.
  const grooveFrom = -twistDeg - slotWidthDeg / 2;
  const grooveTo = lugWidthDeg / 2 + gapDeg;
  const landDeg = 360 / n - (grooveTo - grooveFrom);
  if ((landDeg * Math.PI * (rTip - g)) / 180 < BAYONET_MIN_LAND) return tooSmall;

  const lugProfile: [number, number][] = [
    [rEmbed, underside(rEmbed, 0)],
    [rEmbed, zTop],
    [rTip, zTop],
    [rTip, zTip],
  ];
  const grooveProfile: [number, number][] = [
    [rTip - g, underside(rTip - g, g)],
    [rOut, underside(rOut, g)],
    [rOut, zTop + g],
    [rTip - g, zTop + g],
  ];
  const slotProfile: [number, number][] = [
    [rTip - g, -JOINT_ENGAGE_DEPTH - 1],
    [rOut, -JOINT_ENGAGE_DEPTH - 1],
    [rOut, zTop + g],
    [rTip - g, zTop + g],
  ];

  const lugAnglesDeg = Array.from({ length: n }, (_, i) => (360 * i) / n);
  return {
    layout: {
      lugAnglesDeg,
      twistDeg,
      lugs: lugAnglesDeg.map((a) => ({ profile: lugProfile, startDeg: a - lugWidthDeg / 2, sweepDeg: lugWidthDeg })),
      cuts: lugAnglesDeg.flatMap((a) => [
        { profile: slotProfile, startDeg: a - twistDeg - slotWidthDeg / 2, sweepDeg: slotWidthDeg },
        { profile: grooveProfile, startDeg: a + grooveFrom, sweepDeg: grooveTo - grooveFrom },
      ]),
    },
  };
}

/**
 * The cap joint actually built (issue #167): the spec's own, except that a
 * bayonet or snap the core can't take (`bayonetLayout`'s warning, no
 * `snapLayout`) becomes the plain press-fit collar. design.ts and the STEP
 * backend both call this, so they always build the same joint; the spec
 * itself keeps its joint.
 */
export function resolveCapJoint(
  spec: { joint: JointKind; tolerance: number; shape: { kind: ShapeKind } },
  wallSpec: JointWall,
): { joint: JointKind; bayonet?: BayonetLayout; snap?: SnapLayout; warning?: string } {
  if (spec.joint === "snap") {
    const snap = snapLayout(wallSpec, spec.tolerance);
    return snap ? { joint: "snap", snap } : { joint: "press", warning: "This core is too small for the snap clips, so the top cap uses a press-fit collar." };
  }
  if (spec.joint !== "bayonet") return { joint: spec.joint };
  const plan = bayonetLayout(spec.shape.kind, wallSpec, spec.tolerance);
  return plan.layout ? { joint: "bayonet", bayonet: plan.layout } : { joint: "press", warning: plan.warning };
}

/** One cross-section of an `OutlineStack`: `outline`'s own boundary at height `z`. */
export interface OutlineStation {
  outline: ShapeOutline;
  z: number;
}

/**
 * A solid lofted bottom to top through its stations, each pair of
 * neighbours joined by a ruled surface: a prism where two neighbours share
 * one outline, a frustum where they don't. Every station of one stack is a
 * Steiner offset of the same outline (or a circle), so each frustum is
 * convex -- the mesh backend builds it as a hull, the STEP backend as a
 * ruled loft, and the two agree.
 */
export type OutlineStack = OutlineStation[];

/** A ring added inside the core's bore: `lip`, a band welded into the wall, with `relief` cut from it (never from the wall itself). */
export interface BoreRing {
  lip: OutlineStack;
  relief: OutlineStack;
}

/**
 * The snap joint's shared layout (issues #168, #186), built by both the mesh
 * and the STEP backend. All heights are relative to the core's top rim,
 * which is also the cap's local frame (plate z = [0, CAP_THICKNESS], fingers
 * reaching down to z = -SNAP_FINGER_LENGTH).
 *
 * The collar is split into one finger per side of the bore's outline, with
 * the relief slots at its corners, so every finger is a side that bends as a
 * plate and no barb sits on a stiff corner. Each barb follows the collar's
 * outline, so it engages the ridge evenly along the whole finger, on every
 * shape.
 *
 * Each printed part prints without supports. The cap prints plate down: each
 * barb has a SNAP_LEAD_IN_ANGLE lead-in face toward the finger's tip (facing
 * up as printed) and a 45-degree back face toward the plate. The core prints
 * upright: the ridge has a 45-degree chamfer under it and a 45-degree
 * lead-in above it. The latch is a pair of parallel 45-degree faces (the
 * barb's back face under the ridge's underside).
 *
 * Seated, the barb's back face sits SNAP_PRELOAD into the ridge's underside,
 * so the fingers stay a little bent: they pull the cap down onto the rim and
 * centre it, and it has no radial, axial or tilt play.
 *
 * The barbs stay inside the bore (SNAP_BARB_CLEARANCE + tolerance from its
 * wall), so the core-side features are rings added inside the bore, welded
 * into the wall: the ridge, and a seat under the finger tips that narrows
 * the bore to the cap's hole, so looking down the seated cap there is no
 * step. Nothing is cut into the wall, which keeps its full thickness behind
 * the cable groove.
 */
export interface SnapLayout {
  /** How far the fingers reach down into the bore: their tips are at z = -depth. */
  depth: number;
  /** The relief slots between the fingers, at the outline's corners, degrees. */
  slotAnglesDeg: number[];
  /** The barb ring around the finger tips (cap frame): from just inside the finger at its tip, the lead-in out to the barb's point at `collarRadius + SNAP_BARB`, then a 45-degree back face into the finger again. */
  barb: OutlineStack;
  /**
   * Issue #172: the top of the fingers' root flare, which widens the collar
   * over its top JOINT_TRANSITION_HEIGHT where it meets the plate. Issue
   * #186: it reaches out as far as the barbs, so it clears the bore by the
   * same gap.
   */
  rootOutline: ShapeOutline;
  /** How far the relief slots between the fingers reach out, past the barb and the root flare at every angle. */
  slotOuterRadius: number;
  /** Added to the core: the ridge, then the seat under the finger tips (left out on a core too short for it, or a collar with no hole). */
  rings: BoreRing[];
  /** The cap's through-hole, down past the finger tips. Undefined when the collar has no hole (`jointGeometry`'s `holeOutline`). */
  hole?: OutlineStack;
}

/** `o` inset by `amount`, with the corner radius floored just above 0 (an inset past the corner radius would invert the outline). */
function inset(o: ShapeOutline, amount: number): ShapeOutline {
  return { n: o.n, apothem: o.apothem - amount, cornerRadius: Math.max(SHAPE_ROUNDING_EPS, o.cornerRadius - amount) };
}

/** Undefined when the bore or the core is too small for the snap clips (see JOINT_MIN_BORE_RADIUS): both parts then fall back to the plain press collar (`resolveCapJoint`). */
export function snapLayout(wallSpec: JointWall, tolerance: number): SnapLayout | undefined {
  const { boreOutline, height: coreHeight } = wallSpec;
  const { boreRadius, collarOutline, holeOutline } = jointGeometry(boreOutline, "snap", tolerance);
  const depth = SNAP_FINGER_LENGTH;
  if (boreRadius < JOINT_MIN_BORE_RADIUS || coreHeight < depth + 2) return undefined;

  // Cap side: the barb. Both faces start a little inside the finger (by
  // `embed`), so they weld in rather than meet its surface at a tangent.
  const tip = -depth;
  const embed = 0.2;
  const barbPoint = tip + (SNAP_BARB + embed) / Math.tan((SNAP_LEAD_IN_ANGLE * Math.PI) / 180);
  const barbOutline = offsetOutline(collarOutline, SNAP_BARB);
  const barb: OutlineStack = [
    { outline: inset(collarOutline, embed), z: tip },
    { outline: barbOutline, z: barbPoint },
    { outline: inset(collarOutline, embed), z: barbPoint + SNAP_BARB + embed },
  ];
  const rootOutline = inset(boreOutline, SNAP_BARB_CLEARANCE + tolerance);
  const slotOuterRadius = Math.max(circumscribedRadius(barbOutline, 0), circumscribedRadius(rootOutline, 0)) + 0.5;
  const slotAnglesDeg = Array.from({ length: boreOutline.n }, (_, i) => (360 * i) / boreOutline.n);
  const hole: OutlineStack | undefined = holeOutline && [
    { outline: holeOutline, z: tip - 1 },
    { outline: holeOutline, z: CAP_THICKNESS + 1 },
  ];

  // Core side. Every ring follows the bore's shape, so it stays parallel to
  // the collar at every angle, corners included. Its chamfers run out past
  // the bore (by WELD_OVERLAP) and the lip they are cut from is welded
  // WELD_OVERLAP / 2 into the wall, so a ring meets the bore at 45 degrees
  // instead of being nearly tangent to it, which boolean CSG handles poorly.
  // The rings sit beside the cable groove, so a lip never reaches more than
  // halfway through the wall behind the groove's floor.
  // A chamfer's rise is the widest horizontal step (at the corners when an
  // outline's corner radius is floored), so none is steeper than 45 degrees.
  const wideOutline = offsetOutline(boreOutline, WELD_OVERLAP);
  const wallBehindGroove = wallSpec.outline.apothem - wallSpec.grooveDepth - boreOutline.apothem;
  const lipOutline = offsetOutline(boreOutline, Math.min(WELD_OVERLAP / 2, wallBehindGroove / 2));
  const runTo = (o: ShapeOutline) => circumscribedRadius(wideOutline, 0) - circumscribedRadius(o, 0);

  // The ridge. The barb's back face meets the ridge's inner edge `engage`
  // above the barb's point; the ridge sits `preload` lower than that.
  const ridgeOutline = inset(boreOutline, SNAP_RIDGE_DEPTH);
  const engage = SNAP_RIDGE_DEPTH - SNAP_BARB_CLEARANCE - tolerance;
  const preload = Math.max(0, Math.min(SNAP_PRELOAD, engage / 2));
  const run = runTo(ridgeOutline);
  const [ridgeLo, ridgeHi] = [barbPoint + engage - preload, barbPoint + engage - preload + SNAP_RIDGE_THICKNESS];
  const rings: BoreRing[] = [
    {
      relief: [
        { outline: wideOutline, z: ridgeLo - run - 1 },
        { outline: wideOutline, z: ridgeLo - run },
        { outline: ridgeOutline, z: ridgeLo },
        { outline: ridgeOutline, z: ridgeHi },
        { outline: wideOutline, z: ridgeHi + run },
        { outline: wideOutline, z: ridgeHi + run + 1 },
      ],
      // Ends just inside the chamfers' outer ends, where the relief is already
      // wider than it, so the ring comes to an edge inside the wall at both ends.
      lip: [
        { outline: lipOutline, z: ridgeLo - run + 0.1 },
        { outline: lipOutline, z: ridgeHi + run - 0.1 },
      ],
    },
  ];

  // The seat: under the finger tips the bore narrows to the cap's hole, with
  // a flat top (facing up as the core prints) and a 45-degree chamfer under it.
  if (holeOutline) {
    const seatTop = tip - SNAP_SEAT_GAP;
    const seatBottom = seatTop - runTo(holeOutline);
    if (seatBottom > -coreHeight + 1) {
      rings.push({
        relief: [
          { outline: wideOutline, z: seatBottom - 1 },
          { outline: wideOutline, z: seatBottom },
          { outline: holeOutline, z: seatTop },
          { outline: holeOutline, z: seatTop + 1 },
        ],
        lip: [
          { outline: lipOutline, z: seatBottom + 0.1 },
          { outline: lipOutline, z: seatTop },
        ],
      });
    }
  }
  return { depth, slotAnglesDeg, barb, rootOutline, slotOuterRadius, rings, hole };
}
