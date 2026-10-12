import {
  DEFAULT_THROUGH_HOLE_DIAMETER,
  SCREW_MOUNT_ANNULUS_WIDTH,
  SCREW_MOUNT_AXIS_SEARCH_MAX_DEG,
  SCREW_MOUNT_EDGE_MARGIN,
  SCREW_MOUNT_HEAD_RADIUS,
  SCREW_MOUNT_RECESS_DEPTH,
  SCREW_MOUNT_SLOT_TRAVEL,
  SCREW_MOUNT_TWO_SLOT_ANGLE_DEG,
  SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD,
  THROUGH_MOUNT_CORNER_NUDGE_DEG,
  THROUGH_MOUNT_COUNTERSINK_LAND,
  THROUGH_MOUNT_EDGE_MARGIN,
  THROUGH_MOUNT_RIM_MARGIN,
  THROUGH_MOUNT_SLIDE_STEP,
  THROUGH_MOUNT_PAD_CLEARANCE,
  THROUGH_MOUNT_ROUND_HOLE_COUNTS,
} from "./constants";
import type { XY } from "./innerEnd";
import { isFullCircle, circumscribedRadius, inscribedRadius, offsetOutline, outlineOffsetAt, radiusAtAngle } from "./shapes";
import type { ShapeOutline } from "./shapes";

const TIE_TOLERANCE = 1e-6;
const FIT_SAFETY_MARGIN = 1e-6;
const PAD_CHECK_HAIR = 1e-3;
const MARGIN_BISECTION_STEPS = 50;
const DEGENERATE_EDGE_LENGTH_SQUARED = 1e-12;
const SLIDE_END_TOLERANCE = 1e-9;

export const WALL_UP = { x: 0, y: 1 } as const;

export function standardAngleRad(thetaDeg: number): number {
  return ((90 - thetaDeg) * Math.PI) / 180;
}

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

export function bestAxisDeg(boreOutline: ShapeOutline, fanDeg: number, keyholeRotation = 0): number {
  const candidates = candidateAxisDegs(boreOutline.n);

  const cheapestOf = (pool: number[]): number => {
    let best = pool[0] ?? 0;
    let bestRadius = Infinity;
    for (const theta of pool) {
      const r = radiusAtAngle(boreOutline, standardAngleRad(theta + fanDeg));
      const tied = Math.abs(r - bestRadius) < TIE_TOLERANCE;
      if (r < bestRadius - TIE_TOLERANCE || (tied && Math.abs(theta) < Math.abs(best))) {
        bestRadius = r;
        best = theta;
      }
    }
    return best;
  };

  if (keyholeRotation === 0) return cheapestOf(candidates);

  const cheapestAxis = cheapestOf(candidates);
  const others = candidates.filter((theta) => Math.abs(theta - cheapestAxis) > TIE_TOLERANCE);
  const pool = others.length > 0 ? others : candidates;

  let best = pool[0] ?? cheapestAxis;
  let bestDist = Infinity;
  let bestRadius = Infinity;
  for (const theta of pool) {
    const dist = Math.abs(theta - keyholeRotation);
    const r = radiusAtAngle(boreOutline, standardAngleRad(theta + fanDeg));
    const tiedDist = Math.abs(dist - bestDist) < TIE_TOLERANCE;
    if (dist < bestDist - TIE_TOLERANCE || (tiedDist && r < bestRadius - TIE_TOLERANCE)) {
      bestDist = dist;
      bestRadius = r;
      best = theta;
    }
  }
  return best;
}

export function requiredFlangeMargin(outline: ShapeOutline, boreOutline: ShapeOutline, keyholeRotation = 0): number {
  const requiredAnnulusAt = (fanDeg: number): number => {
    const axis = bestAxisDeg(boreOutline, fanDeg, keyholeRotation);
    const phi = standardAngleRad(axis + fanDeg);
    const wallR = radiusAtAngle(outline, phi);
    const target = wallR + SCREW_MOUNT_ANNULUS_WIDTH + FIT_SAFETY_MARGIN;

    const flangeRadiusAt = (margin: number) => radiusAtAngle(offsetOutline(outline, margin), phi);
    let lo = 0;
    let hi = 1;
    while (flangeRadiusAt(hi) < target) hi *= 2;
    for (let i = 0; i < MARGIN_BISECTION_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (flangeRadiusAt(mid) < target) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  return Math.max(requiredAnnulusAt(0), requiredAnnulusAt(SCREW_MOUNT_TWO_SLOT_ANGLE_DEG));
}

export interface KeyholeSlot {
  head: { x: number; y: number };
  shankEnd: { x: number; y: number };
}

export interface MountLayout {
  slots: KeyholeSlot[];
  recessDepth: number;
  warning?: string;
  axisDeg?: number;
}

export function layoutKeyholeMount(outline: ShapeOutline, boreOutline: ShapeOutline, margin: number, keyholeRotation = 0): MountLayout {
  const halfTravel = SCREW_MOUNT_SLOT_TRAVEL / 2;
  const flangeOutline = offsetOutline(outline, margin);

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
    const axis = bestAxisDeg(boreOutline, SCREW_MOUNT_TWO_SLOT_ANGLE_DEG, keyholeRotation);
    const left = slotAt(axis - SCREW_MOUNT_TWO_SLOT_ANGLE_DEG);
    const right = slotAt(axis + SCREW_MOUNT_TWO_SLOT_ANGLE_DEG);
    if (left && right) return { slots: [left, right], recessDepth: SCREW_MOUNT_RECESS_DEPTH, axisDeg: axis };
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

export interface ThroughHole {
  x: number;
  y: number;
}

export interface ThroughMountLayout {
  holes: ThroughHole[];
  holeRadius: number;
  warning?: string;
}

export function requiredThroughMountMargin(
  outline: ShapeOutline,
  _boreOutline: ShapeOutline,
  holeDiameter: number = DEFAULT_THROUGH_HOLE_DIAMETER,
  collarOffset = 0,
): number {
  const holeRadius = holeDiameter / 2;
  const isRound = isFullCircle(outline);
  const outlineR0 = isRound ? outline.apothem : circumscribedRadius(outline, 0);
  const target = outlineR0 + throughHoleInset(collarOffset) + 2 * holeRadius + THROUGH_MOUNT_RIM_MARGIN + FIT_SAFETY_MARGIN;
  return Math.max(0, target - outlineR0);
}

export function throughHoleCountersink(holeRadius: number, plateThickness: number): { radius: number; depth: number } {
  const radius = Math.max(holeRadius, Math.min(2 * holeRadius, holeRadius + THROUGH_MOUNT_EDGE_MARGIN, holeRadius + plateThickness - THROUGH_MOUNT_COUNTERSINK_LAND));
  return { radius, depth: radius - holeRadius };
}

function throughHoleInset(collarOffset: number): number {
  return THROUGH_MOUNT_EDGE_MARGIN + (collarOffset > 0 ? collarOffset + THROUGH_MOUNT_PAD_CLEARANCE + PAD_CHECK_HAIR : 0);
}

export function distanceToClosedPolygon(px: number, py: number, points: XY[]): number {
  let best = Infinity;
  let inside = false;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a.y > py !== b.y > py && px < a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > DEGENERATE_EDGE_LENGTH_SQUARED ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}

export function layoutThroughHoleMount(
  outline: ShapeOutline,
  _boreOutline: ShapeOutline,
  margin: number,
  holeDiameter: number = DEFAULT_THROUGH_HOLE_DIAMETER,
  keepOut: { channelRibbon: XY[]; pads?: XY[][] },
  collarOffset = 0,
): ThroughMountLayout {
  const holeRadius = holeDiameter / 2;
  const flangeOutline = offsetOutline(outline, margin);
  const isRound = isFullCircle(outline);
  const base = { holeRadius };
  const tooNarrowWarning = "The flange is too narrow (or too close to the inner-end cable channel) to fit the through-hole mount (increase the core size, or the mount was skipped).";

  const clearOfChannel = (x: number, y: number): boolean => {
    const headRadius = holeRadius + THROUGH_MOUNT_EDGE_MARGIN;
    const clearOfRibbon = keepOut.channelRibbon.length < 3 || distanceToClosedPolygon(x, y, keepOut.channelRibbon) >= headRadius;
    return clearOfRibbon && (keepOut.pads ?? []).every((pad) => distanceToClosedPolygon(x, y, pad) >= headRadius + THROUGH_MOUNT_PAD_CLEARANCE);
  };

  const holeAt = (phi: number): ThroughHole | null => {
    const innerLimit = radiusAtAngle(outline, phi) + throughHoleInset(collarOffset) + holeRadius;
    const outerLimit = radiusAtAngle(flangeOutline, phi) - THROUGH_MOUNT_RIM_MARGIN - holeRadius;
    const fitsAtTrueOffset = (x: number, y: number) => {
      const o = outlineOffsetAt(outline, x, y).offset;
      return o >= throughHoleInset(collarOffset) + holeRadius - FIT_SAFETY_MARGIN && o + holeRadius + THROUGH_MOUNT_RIM_MARGIN <= margin + FIT_SAFETY_MARGIN;
    };
    for (let R = innerLimit; R <= outerLimit + SLIDE_END_TOLERANCE; R += THROUGH_MOUNT_SLIDE_STEP) {
      const h = { x: R * Math.cos(phi), y: R * Math.sin(phi) };
      if (fitsAtTrueOffset(h.x, h.y) && clearOfChannel(h.x, h.y)) return h;
    }
    return null;
  };

  if (isRound) {
    for (const count of THROUGH_MOUNT_ROUND_HOLE_COUNTS) {
      const ringAt = (offsetDeg: number): ThroughHole[] | null => {
        const holes: ThroughHole[] = [];
        for (let i = 0; i < count; i++) {
          const h = holeAt((2 * Math.PI * i) / count + (offsetDeg * Math.PI) / 180);
          if (!h) return null;
          holes.push(h);
        }
        return holes;
      };
      const plain = ringAt(0);
      if (plain) return { ...base, holes: plain };
      let widestClearRun: { from: number; to: number } | undefined;
      let run: { from: number; to: number } | undefined;
      for (let o = 1; o < 360 / count; o++) {
        run = ringAt(o) ? { from: run?.from ?? o, to: o } : undefined;
        if (run && (!widestClearRun || run.to - run.from > widestClearRun.to - widestClearRun.from)) widestClearRun = run;
      }
      const rotated = widestClearRun && ringAt(Math.round((widestClearRun.from + widestClearRun.to) / 2));
      if (rotated) return { ...base, holes: rotated };
    }
    return { ...base, holes: [], warning: tooNarrowWarning };
  }

  const holes: ThroughHole[] = [];
  let skipped = 0;
  for (let i = 0; i < outline.n; i++) {
    const phi = (2 * Math.PI * i) / outline.n;
    let h: ThroughHole | null = null;
    for (let k = 0; !h && k <= THROUGH_MOUNT_CORNER_NUDGE_DEG; k++) h = holeAt(phi + (k * Math.PI) / 180) ?? holeAt(phi - (k * Math.PI) / 180);
    if (h) holes.push(h);
    else skipped++;
  }
  if (holes.length === 0) return { ...base, holes: [], warning: tooNarrowWarning };
  return { ...base, holes, warning: skipped > 0 ? `${skipped} through-hole(s) skipped near a corner too close to the inner-end cable channel.` : undefined };
}
