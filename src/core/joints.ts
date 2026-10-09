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
  SNAP_LEAD_IN_ANGLE_DEG,
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

const MIN_JOINT_RADIUS = 2;
const MIN_COLLAR_RADIUS = 1;
const MIN_HOLE_APOTHEM = 1;
const CUT_OVERSHOOT = 1;
const MIN_HEIGHT_BELOW_ENGAGE = 2;
const BARB_EMBED = 0.2;
const SLOT_REACH_PAST_BARB = 0.5;
const RING_RUNOUT = 1;
const LIP_END_INSET = 0.1;
const MIN_SEAT_CLEARANCE = 1;
const MIN_GROOVE_CLEARANCE = 1;
const HOLE_OVERSHOOT = 1;

export type JointWall = Pick<WallSpec, "boreOutline" | "height" | "outline" | "grooveDepth">;

export interface JointGeometry {
  boreRadius: number;
  jointRadius: number;
  collarRadius: number;
  collarOutline: ShapeOutline;
  holeOutline?: ShapeOutline;
}

export function jointGeometry(boreOutline: ShapeOutline, kind: JointKind, tolerance: number): JointGeometry {
  const boreRadius = inscribedRadius(boreOutline, 0);
  const jointRadius = Math.max(MIN_JOINT_RADIUS, boreRadius - JOINT_FIT_GAP);
  const collarRadius =
    kind === "press"
      ? Math.max(MIN_COLLAR_RADIUS, jointRadius - tolerance)
      : kind === "bayonet"
        ? Math.max(MIN_COLLAR_RADIUS, jointRadius - BAYONET_GAP - tolerance)
        : Math.max(MIN_COLLAR_RADIUS, boreRadius - SNAP_BARB_CLEARANCE - tolerance - SNAP_BARB);
  const collarOutline: ShapeOutline = {
    n: boreOutline.n,
    apothem: collarRadius,
    cornerRadius: Math.max(SHAPE_ROUNDING_EPS, boreOutline.cornerRadius - (boreRadius - collarRadius)),
  };
  const collarWall =
    kind === "bayonet" ? BAYONET_LUG_HEIGHT + BAYONET_GAP + tolerance + BAYONET_MIN_WALL : kind === "snap" ? SNAP_COLLAR_WALL : CAP_COLLAR_WALL;
  const holeApothem = collarRadius - collarWall;
  const holeOutline: ShapeOutline | undefined =
    holeApothem >= MIN_HOLE_APOTHEM
      ? { n: boreOutline.n, apothem: holeApothem, cornerRadius: Math.max(SHAPE_ROUNDING_EPS, collarOutline.cornerRadius - collarWall) }
      : undefined;
  return { boreRadius, jointRadius, collarRadius, collarOutline, holeOutline };
}

export interface RevolvedFeature {
  profile: [number, number][];
  startDeg: number;
  sweepDeg: number;
}

export interface BayonetLayout {
  lugAnglesDeg: number[];
  twistDeg: number;
  lugs: RevolvedFeature[];
  cuts: RevolvedFeature[];
}

export type BayonetPlan = { layout: BayonetLayout; warning?: undefined } | { layout?: undefined; warning: string };

const deg = (rad: number) => (rad * 180) / Math.PI;

export function bayonetLayout(shape: ShapeKind, wallSpec: JointWall, tolerance: number): BayonetPlan {
  if (shape !== "round") return { warning: "Twist lock needs a round core, so the top cap uses a press-fit collar." };
  const tooSmall = { warning: "This core is too small for the twist lock, so the top cap uses a press-fit collar." };

  const { boreOutline, height } = wallSpec;
  const boreR = inscribedRadius(boreOutline, 0);
  if (boreR < JOINT_MIN_BORE_RADIUS || height < JOINT_ENGAGE_DEPTH + MIN_HEIGHT_BELOW_ENGAGE) return tooSmall;
  const { collarRadius: collarR } = jointGeometry(boreOutline, "bayonet", tolerance);

  const slideGap = BAYONET_GAP + tolerance;
  const lugTipR = collarR - BAYONET_LUG_HEIGHT;
  const lugEmbedR = boreR + WELD_OVERLAP;
  const cutOuterR = collarR + CUT_OVERSHOOT;
  const lugTopZ = -BAYONET_LUG_DROP;
  const lugTipBottomZ = lugTopZ - BAYONET_LUG_TIP;
  const underside = (r: number, by: number) => lugTipBottomZ - (r - lugTipR) - by * Math.SQRT2;
  if (underside(cutOuterR, slideGap) < -JOINT_ENGAGE_DEPTH + MIN_GROOVE_CLEARANCE) return tooSmall;

  const n = BAYONET_LUG_COUNT;
  const twistDeg = 180 / n;
  const lugWidthDeg = Math.min(deg(BAYONET_LUG_WIDTH / collarR), BAYONET_LUG_MAX_DEG);
  const gapDeg = deg(slideGap / (lugTipR - slideGap));
  const slotWidthDeg = lugWidthDeg + 2 * gapDeg;
  const grooveFrom = -twistDeg - slotWidthDeg / 2;
  const grooveTo = lugWidthDeg / 2 + gapDeg;
  const landDeg = 360 / n - (grooveTo - grooveFrom);
  if ((landDeg * Math.PI * (lugTipR - slideGap)) / 180 < BAYONET_MIN_LAND) return tooSmall;

  const lugProfile: [number, number][] = [
    [lugEmbedR, underside(lugEmbedR, 0)],
    [lugEmbedR, lugTopZ],
    [lugTipR, lugTopZ],
    [lugTipR, lugTipBottomZ],
  ];
  const grooveProfile: [number, number][] = [
    [lugTipR - slideGap, underside(lugTipR - slideGap, slideGap)],
    [cutOuterR, underside(cutOuterR, slideGap)],
    [cutOuterR, lugTopZ + slideGap],
    [lugTipR - slideGap, lugTopZ + slideGap],
  ];
  const slotProfile: [number, number][] = [
    [lugTipR - slideGap, -JOINT_ENGAGE_DEPTH - CUT_OVERSHOOT],
    [cutOuterR, -JOINT_ENGAGE_DEPTH - CUT_OVERSHOOT],
    [cutOuterR, lugTopZ + slideGap],
    [lugTipR - slideGap, lugTopZ + slideGap],
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

export interface OutlineStation {
  outline: ShapeOutline;
  z: number;
}

export type OutlineStack = OutlineStation[];

export interface BoreRing {
  lip: OutlineStack;
  relief: OutlineStack;
}

export interface SnapLayout {
  depth: number;
  slotAnglesDeg: number[];
  barb: OutlineStack;
  rootOutline: ShapeOutline;
  slotOuterRadius: number;
  rings: BoreRing[];
  hole?: OutlineStack;
}

function inset(o: ShapeOutline, amount: number): ShapeOutline {
  return { n: o.n, apothem: o.apothem - amount, cornerRadius: Math.max(SHAPE_ROUNDING_EPS, o.cornerRadius - amount) };
}

export function snapLayout(wallSpec: JointWall, tolerance: number): SnapLayout | undefined {
  const { boreOutline, height: coreHeight } = wallSpec;
  const { boreRadius, collarOutline, holeOutline } = jointGeometry(boreOutline, "snap", tolerance);
  const depth = SNAP_FINGER_LENGTH;
  if (boreRadius < JOINT_MIN_BORE_RADIUS || coreHeight < depth + MIN_HEIGHT_BELOW_ENGAGE) return undefined;

  const tip = -depth;
  const barbPoint = tip + (SNAP_BARB + BARB_EMBED) / Math.tan((SNAP_LEAD_IN_ANGLE_DEG * Math.PI) / 180);
  const barbOutline = offsetOutline(collarOutline, SNAP_BARB);
  const barb: OutlineStack = [
    { outline: inset(collarOutline, BARB_EMBED), z: tip },
    { outline: barbOutline, z: barbPoint },
    { outline: inset(collarOutline, BARB_EMBED), z: barbPoint + SNAP_BARB + BARB_EMBED },
  ];
  const rootOutline = inset(boreOutline, SNAP_BARB_CLEARANCE + tolerance);
  const slotOuterRadius = Math.max(circumscribedRadius(barbOutline, 0), circumscribedRadius(rootOutline, 0)) + SLOT_REACH_PAST_BARB;
  const slotAnglesDeg = Array.from({ length: boreOutline.n }, (_, i) => (360 * i) / boreOutline.n);
  const hole: OutlineStack | undefined = holeOutline && [
    { outline: holeOutline, z: tip - HOLE_OVERSHOOT },
    { outline: holeOutline, z: CAP_THICKNESS + HOLE_OVERSHOOT },
  ];

  const reliefOutline = offsetOutline(boreOutline, WELD_OVERLAP);
  const wallBehindGroove = wallSpec.outline.apothem - wallSpec.grooveDepth - boreOutline.apothem;
  const lipOutline = offsetOutline(boreOutline, Math.min(WELD_OVERLAP / 2, wallBehindGroove / 2));
  const chamferRunTo = (o: ShapeOutline) => circumscribedRadius(reliefOutline, 0) - circumscribedRadius(o, 0);

  const ridgeOutline = inset(boreOutline, SNAP_RIDGE_DEPTH);
  const ridgeEngagement = SNAP_RIDGE_DEPTH - SNAP_BARB_CLEARANCE - tolerance;
  const seatedPreload = Math.max(0, Math.min(SNAP_PRELOAD, ridgeEngagement / 2));
  const ridgeChamferRun = chamferRunTo(ridgeOutline);
  const [ridgeLo, ridgeHi] = [barbPoint + ridgeEngagement - seatedPreload, barbPoint + ridgeEngagement - seatedPreload + SNAP_RIDGE_THICKNESS];
  const rings: BoreRing[] = [
    {
      relief: [
        { outline: reliefOutline, z: ridgeLo - ridgeChamferRun - RING_RUNOUT },
        { outline: reliefOutline, z: ridgeLo - ridgeChamferRun },
        { outline: ridgeOutline, z: ridgeLo },
        { outline: ridgeOutline, z: ridgeHi },
        { outline: reliefOutline, z: ridgeHi + ridgeChamferRun },
        { outline: reliefOutline, z: ridgeHi + ridgeChamferRun + RING_RUNOUT },
      ],
      lip: [
        { outline: lipOutline, z: ridgeLo - ridgeChamferRun + LIP_END_INSET },
        { outline: lipOutline, z: ridgeHi + ridgeChamferRun - LIP_END_INSET },
      ],
    },
  ];

  if (holeOutline) {
    const seatTop = tip - SNAP_SEAT_GAP;
    const seatBottom = seatTop - chamferRunTo(holeOutline);
    if (seatBottom > -coreHeight + MIN_SEAT_CLEARANCE) {
      rings.push({
        relief: [
          { outline: reliefOutline, z: seatBottom - RING_RUNOUT },
          { outline: reliefOutline, z: seatBottom },
          { outline: holeOutline, z: seatTop },
          { outline: holeOutline, z: seatTop + RING_RUNOUT },
        ],
        lip: [
          { outline: lipOutline, z: seatBottom + LIP_END_INSET },
          { outline: lipOutline, z: seatTop },
        ],
      });
    }
  }
  return { depth, slotAnglesDeg, barb, rootOutline, slotOuterRadius, rings, hole };
}
